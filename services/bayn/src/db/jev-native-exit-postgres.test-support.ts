import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { chartProviderFixture } from '../jev/entry-inference.test-support'
import { makeReplayInferenceBudget } from '../intraday-replay/inference-timing'
import { expect } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Cause, Clock, Effect, Exit, Layer, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayInferenceTiming } from '../intraday-replay/inference-timing'
import { makeSimulatedExecutionClock } from '../intraday-replay/clock'
import { utcInstantFromEpochMillis } from '../time'
import { BrokerRead, type BrokerReadShape } from '../broker/alpaca/model'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { sourceTimestamp } from '../broker/observations'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { CryptoFeeTier } from '../broker/crypto-fees'
import { CycleStore } from '../cycle/store/model'
import { Authority, KillState, OrderSide, OrderStatus, OrderType, TimeInForce } from '../execution/contracts'
import { BrokerAccess, grantedCapitalAuthority, makeExecutionAuthority } from '../execution/authority'
import { makeBrokerStateCache } from '../execution/broker-state-cache'
import { makeExecutionProgram } from '../execution/runtime-program'
import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion } from '../jev/batch'
import { JevClient } from '../jev/client'
import { JevPositionStore } from '../jev/portfolio'
import { clientOrderIdForIntentId, IntentStore } from '../execution/intents/domain'
import { WriterFence, WriterFenceError, type WriterFenceService } from '../execution/writer-fence'
import { MutationStore } from '../execution/mutations/model'
import { advancePositionProtection } from '../observe-composition/position-protection-interpreter'
import { executionEvidenceContinuationDelayMs } from '../observe-composition/recovery-driver'
import { IntentStoreLive } from '../execution/intents/postgres'
import { ensureExecutionCycleClosure } from '../observe-composition/execution-cycle'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { makeExecutionCycleClosure, ExecutionCycleClosureStore } from './execution-cycle-closure'
import type { IntradayMarketDataService } from '../market-data/intraday/model'
import { nativeJevInference } from '../jev/native.test-support'
import { evaluateJevPositionManagement } from '../jev/runtime'
import { JevExitReason } from '../jev/exit'
import { currentEquityMarketProfile as equityMarketProfile } from '../jev/markets'
import {
  buildMutationShadowCycleDecision,
  prepareClosingExecutionCycleDecision,
} from '../observe-composition/decision-builder'
import type { ReconciliationPassResult } from '../reconciler'
import {
  decisionSourceRows,
  ExecutionDecisionDocumentSchema,
  type ExecutionDecisionDocument,
} from '../shadow-decision-contract'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { verifyBrokerStateVersion } from './reconciliation'
import { longEntryBrokerReads } from '../testing/entry-broker-reads.test-support'
import {
  type NativeJevPostgres,
  replayAccountId,
  fixture,
  retainedRuntime,
  observed,
  atObservation,
  nativeInput,
  acquireEntryCycle,
  seedManagedPosition,
} from './jev-native-postgres.test-support'

export const nativeExitPersistence = async (postgres: NativeJevPostgres, scenario: string) => {
  const providerClock = await Effect.runPromise(Clock.clockWith(Effect.succeed))
  const source = fixture.portfolio.brokerState
  const material = { ...source, account: { ...source.account, cryptoFeeTier: CryptoFeeTier.Four } }
  const hash = Result.getOrThrow(reconciledStateHash(material))
  const state =
    scenario === 'fee-source'
      ? {
          ...material,
          reconciliation: {
            ...source.reconciliation,
            reconciliationId: 'f'.repeat(64),
            expectedHash: hash,
            observedHash: hash,
          },
        }
      : source
  const at = fixture.observation.payload.observedAt
  let reconciliations = 0
  let calls = 0
  const unused = Effect.die(new Error('Unexpected broker read'))
  const broker: BrokerReadShape = {
    ...longEntryBrokerReads(fixture.portfolio.brokerState.account, at),
    positions: unused,
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
  await postgres.runtime.runPromise(
    Effect.gen(function* () {
      if (scenario === 'fee-source') {
        const sql = yield* PgClient.PgClient
        const r = state.reconciliation
        yield* sql`INSERT INTO reconciliations
          (reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
          VALUES (${r.reconciliationId},${r.schemaVersion},${r.accountId},${r.expectedHash},${r.observedHash},${r.contentHash},'EXACT','[]'::jsonb,${r.reconciledAt})`
      }
      yield* acquireEntryCycle(at)
      const active = yield* (yield* CycleStore).activate(nativeInput.cycleId, at)
      const document = yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: nativeInput.authorityGenerationHash,
        cycle: active.cycle,
        executionModel: fixture.protocol.executionModel,
        policy: yield* Effect.fromResult(makeExecutionRiskPolicy(state.account.accountId, fixture.protocol.universe)),
        strategy: retainedRuntime,
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
      expect(document.strategyDecision?.schemaVersion).toBe('bayn.jev-entry-target.v7')
      expect(document.dispatchable).toBe(true)
      expect(document.orderedIntentIds).toHaveLength(1)
      expect(document.createdAt).toBe(new Date(observed + 7000).toISOString())
      const entryQuote = document.deltaRisk[0]?.facts?.state.entryQuote
      if (entryQuote === undefined) throw new Error('Missing entry quote risk binding')
      expect(entryQuote.maximumAgeMs).toBe(fixture.protocol.maximumQuoteAgeMs)
      expect(document.deltaRisk[0]?.evaluation.decision.expiresAt).toBe(
        new Date(Date.parse(entryQuote.eventAt) + fixture.protocol.maximumQuoteAgeMs).toISOString(),
      )
      if (document.strategyDecision?.schemaVersion !== 'bayn.jev-entry-target.v7')
        throw new Error('Expected native Jev entry target')
      expect(document.strategyDecision.evidence.batchPlan.schemaVersion).toBe(JevBatchPlanVersion.V8)
      expect(Date.parse(document.deltaRisk[0].evaluation.decision.expiresAt)).toBeGreaterThan(
        Date.parse(document.strategyDecision.evidence.batchPlan.expiresAt),
      )
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(ExecutionDecisionDocumentSchema)(JSON.parse(JSON.stringify(document))),
        ),
      ).toBe(true)
      const sourceRows = decisionSourceRows(document)
      if (sourceRows === undefined) throw new Error('Missing bound Jev source rows')
      const { contentHash: _documentHash, ...documentMaterial } = document
      const substitutedSource = {
        ...documentMaterial,
        decisionMarketDataRows: { ...sourceRows, bars: [] },
      }
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(ExecutionDecisionDocumentSchema)({
            ...substitutedSource,
            contentHash: Result.getOrThrow(canonicalHashV1Result(substitutedSource)),
          }),
        ),
      ).toBe(true)
      const { managed, portfolio } = yield* seedManagedPosition({
        entryDocument: document,
        observedAt: new Date(Date.parse(document.createdAt) + 3 * 60_000 + 2000).toISOString(),
        ...(scenario.startsWith('protection-') ? { nativeProtection: 'strategy' as const, settleEntry: true } : {}),
        ...(scenario === 'protection-native-tp-keeps-coverage' ? { completeNativeEntry: true } : {}),
      })
      if (scenario === 'fee-source') {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO authority_state
          (schema_version,generation_hash,maximum,effective,kill_state,reason,version,updated_at)
          VALUES ('bayn.paper-authority.v1',${nativeInput.authorityGenerationHash},'OBSERVE','OBSERVE','CLEAR',NULL,1,
            ${fixture.observation.payload.observedAt})`
        const [authority] = yield* sql<{ version: string }>`SELECT version::text FROM authority_state WHERE singleton`
        if (authority === undefined) throw new Error('Expected authority state')
        const version = {
          reconciliationId: portfolio.brokerState.reconciliation.reconciliationId,
          reconciledAt: portfolio.brokerState.reconciliation.reconciledAt,
          authorityGenerationHash: nativeInput.authorityGenerationHash,
          authorityVersion: Number(authority.version),
        }
        const intentId = document.orderedIntentIds[0]
        if (intentId === undefined) throw new Error('Expected the sealed entry intent')
        expect(yield* verifyBrokerStateVersion(sql, replayAccountId, version, intentId, true)).toBe(18)
        // Isolate the final fee lookup from the immutable decision writer: these
        // rows exercise its accepted identities and account/protocol rejection.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions ON COMMIT DROP
            AS SELECT * FROM public.autonomous_cycle_shadow_decisions`
            // Rebind prepared reads from the public table to the temporary fixture.
            yield* sql`SET LOCAL search_path TO pg_temp, public`
            for (const [targetVersion, policyVersion] of [
              ['bayn.entry-ablation-target.v1', 'bayn.entry-ablation-policy.v1'],
              ['bayn.repeated-momentum-target.v1', 'bayn.repeated-momentum-policy.v1'],
            ]) {
              yield* sql`UPDATE autonomous_cycle_shadow_decisions SET document =
              jsonb_set(jsonb_set(document, '{strategyDecision,schemaVersion}', ${JSON.stringify(targetVersion)}::jsonb),
                '{strategyDecision,policy}', ${sql.json({ schemaVersion: policyVersion, sharedProtocol: fixture.protocol })})`
              expect(yield* verifyBrokerStateVersion(sql, replayAccountId, version, intentId, true)).toBe(18)
              yield* sql`UPDATE autonomous_cycle_shadow_decisions SET document =
              jsonb_set(document, '{strategyDecision,evidence,observation,portfolio,brokerState,account,accountId}', '"foreign-account"'::jsonb)`
              expect(
                Exit.isFailure(
                  yield* verifyBrokerStateVersion(sql, replayAccountId, version, intentId, true).pipe(Effect.exit),
                ),
              ).toBe(true)
              yield* sql`UPDATE autonomous_cycle_shadow_decisions SET document =
              jsonb_set(document, '{strategyDecision,evidence,observation,portfolio,brokerState,account,accountId}', ${JSON.stringify(replayAccountId)}::jsonb)`
              yield* sql`UPDATE autonomous_cycle_shadow_decisions SET document =
              jsonb_set(document, '{strategyDecision,evidence,observation,protocol,schemaVersion}', '"unsupported"'::jsonb)`
              expect(
                Exit.isFailure(
                  yield* verifyBrokerStateVersion(sql, replayAccountId, version, intentId, true).pipe(Effect.exit),
                ),
              ).toBe(true)
              yield* sql`UPDATE autonomous_cycle_shadow_decisions SET document =
              jsonb_set(document, '{strategyDecision,evidence,observation,protocol,schemaVersion}', ${JSON.stringify(fixture.protocol.schemaVersion)}::jsonb)`
            }
          }),
        )
        const missing = yield* verifyBrokerStateVersion(sql, replayAccountId, version, '0'.repeat(64), true).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(missing)).toBe(true)
        if (Exit.isFailure(missing)) expect(Cause.pretty(missing.cause)).toContain('ReconciliationStoreError')
        return
      }
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
                    { AAPL: 0.08 },
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
      expect(exitTarget.reason).toBe(JevExitReason.ProfitTarget)
      expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
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
          strategy: retainedRuntime,
          intradayMarketData: marketData,
        },
        preparation: {
          executionModel: fixture.protocol.executionModel,
          executionPolicy: cycle.identity.executionPolicy,
          strategyProtocolHash: cycle.identity.strategyProtocolHash,
        },
        policy: yield* Effect.fromResult(makeExecutionRiskPolicy(state.account.accountId, fixture.protocol.universe)),
        cycle,
        entryDocument: document,
        reconcile: Effect.succeed(closeFacts),
        initialReconciliation: closeFacts,
        closeExpiresAt: cycle.window.executionCloseAt,
        exitTarget,
      }
      if (scenario.startsWith('protection-')) {
        const keepNative = scenario === 'protection-native-tp-keeps-coverage'
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const entryId = document.orderedIntentIds[0]
        const levels = portfolio.exitPolicy.plans['AAPL']?.levels
        if (entryId === undefined || levels === undefined)
          throw new Error('Expected an approved entry with native protection')
        const cancelAt = managed.observation.payload.observedAt
        const cancelProviderUpdatedAt = Result.getOrThrow(sourceTimestamp(cancelAt))
        yield* sql`UPDATE simulated_execution_clocks SET observed_at=${cancelAt} WHERE account_id=${replayAccountId}`
        const brokerOrderId = 'partial-tp-native-child'
        const eventId = '7'.repeat(64)
        const partialEventId = '8'.repeat(64)
        const parent = portfolio.brokerState.orders[0]
        if (parent === undefined) throw new Error('Expected the filled entry order')
        const entryFill = portfolio.entryFills[0]
        if (entryFill === undefined) throw new Error('Expected canonical entry fill pricing')
        const parentProviderUpdatedAt = Result.getOrThrow(sourceTimestamp(entryFill.occurredAt))
        const partialPriceAtoms = keepNative
          ? String(BigInt(levels.profitLimitPriceMicros) * 1000n)
          : entryFill.priceAtoms
        const partialBasis = ((2_000_000_000n * BigInt(entryFill.priceAtoms)) / 1_000_000_000_000n).toString()
        const partialNotional = ((2_000_000_000n * BigInt(partialPriceAtoms)) / 1_000_000_000_000n).toString()
        const originalQuantity = keepNative ? parent.quantityAtoms : '5000000000'
        if (originalQuantity === undefined) throw new Error('Expected native parent quantity')
        const remainingQuantity = String(BigInt(originalQuantity) - 2_000_000_000n)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (keepNative) {
              const parentEventId = '9'.repeat(64)
              yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
                source_event_id,source_sequence,occurred_at,observed_at) VALUES (${parentEventId},'bayn.paper-broker-event.v1',
                ${parentEventId},'ORDER','ALPACA',${replayAccountId},${`order:${parent.brokerOrderId}:${parentProviderUpdatedAt}`},99,${entryFill.occurredAt},${entryFill.occurredAt})`
              yield* sql`INSERT INTO orders(event_id,account_id,schema_version,broker_order_id,client_order_id,intent_id,
                symbol,side,order_type,time_in_force,quantity_atoms,filled_quantity_atoms,limit_price_micros,status,
                broker_updated_at)
                VALUES (${parentEventId},${replayAccountId},'bayn.order.v3',${parent.brokerOrderId},${parent.clientOrderId},${entryId},
                'AAPL','BUY','LIMIT','DAY',${originalQuantity},${originalQuantity},${parent.limitPriceMicros ?? '0'},'FILLED',
                ${parentProviderUpdatedAt})`
            }
            yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
          source_event_id,source_sequence,occurred_at,observed_at) VALUES (${eventId},'bayn.paper-broker-event.v1',
          ${eventId},'ORDER','ALPACA',${replayAccountId},${`order:${brokerOrderId}:${cancelProviderUpdatedAt}`},100,${cancelAt},${cancelAt})`
            yield* sql`INSERT INTO orders(event_id,account_id,schema_version,broker_order_id,client_order_id,intent_id,
          symbol,side,order_type,time_in_force,quantity_atoms,filled_quantity_atoms,limit_price_micros,status,parent_broker_order_id,
          broker_updated_at)
          VALUES (${eventId},${replayAccountId},'bayn.order.v3',${brokerOrderId},'partial-tp-native-child',${entryId},
          'AAPL','SELL','LIMIT','DAY',${originalQuantity},2000000000,${levels.profitLimitPriceMicros},'PARTIALLY_FILLED',
          ${keepNative ? parent.brokerOrderId : null},${cancelProviderUpdatedAt})`
            yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
              source_event_id,source_sequence,occurred_at,observed_at) VALUES (${partialEventId},'bayn.paper-broker-event.v1',
              ${partialEventId},'FILL','ALPACA',${replayAccountId},'partial-tp-fill',101,${cancelAt},${cancelAt})`
            yield* sql`INSERT INTO fills(event_id,account_id,schema_version,fill_id,broker_order_id,client_order_id,
              intent_id,symbol,side,quantity_atoms,price_atoms,fee_micros,source_timestamp) VALUES (${partialEventId},
              ${replayAccountId},${entryFill.schemaVersion},'partial-tp-fill',${brokerOrderId},'partial-tp-native-child',
              ${entryId},'AAPL','SELL',2000000000,${partialPriceAtoms},0,${cancelAt.replace('Z', '000000Z')})`
            yield* sql`INSERT INTO accounting_transactions(transaction_id,schema_version,broker_event_id,intent_id,
              account_id,symbol,side,quantity_atoms,price_atoms,notional_micros,fee_micros,cost_basis_micros,
              realized_pnl_micros,quantity_delta_atoms,cost_basis_delta_micros,cash_delta_micros,ledger_plan_hash,
              content_hash,occurred_at) VALUES (${partialEventId},'bayn.accounting-transaction.v2',${partialEventId},
              ${entryId},${replayAccountId},'AAPL','SELL',2000000000,${partialPriceAtoms},${partialNotional},0,
              ${partialBasis},${String(BigInt(partialNotional) - BigInt(partialBasis))},-2000000000,${'-' + partialBasis},${partialNotional},${partialEventId},${partialEventId},${cancelAt})`
            yield* sql`INSERT INTO accounting_receipts(receipt_id,schema_version,intent_id,broker_event_id,
              tigerbeetle_cluster_id,tigerbeetle_ledger,account_ids,transfer_ids,debit_micros,credit_micros,content_hash,
              recorded_at) VALUES (${partialEventId},'bayn.paper-accounting-receipt.v1',${entryId},${partialEventId},1,1,
              ARRAY[1,2]::numeric[],ARRAY[999]::numeric[],${partialNotional},${partialNotional},${partialEventId},${cancelAt})`
          }),
        )
        const child = {
          ...parent,
          brokerOrderId,
          clientOrderId: 'partial-tp-native-child',
          intentId: entryId,
          side: OrderSide.Sell,
          orderType: OrderType.Limit,
          status: OrderStatus.PartiallyFilled,
          quantityAtoms: originalQuantity,
          filledQuantityAtoms: '2000000000',
          limitPriceMicros: levels.profitLimitPriceMicros,
          observedAt: cancelAt,
          ...(keepNative ? { timeInForce: TimeInForce.Day } : {}),
          ...(keepNative ? { parentBrokerOrderId: parent.brokerOrderId } : {}),
        }
        const remainingStop = {
          ...child,
          brokerOrderId: 'partial-tp-native-stop',
          clientOrderId: 'partial-tp-native-stop',
          orderType: OrderType.StopLimit,
          status: OrderStatus.Pending,
          quantityAtoms: remainingQuantity,
          filledQuantityAtoms: '0',
          limitPriceMicros: levels.stopLimitPriceMicros,
          stopPriceMicros: levels.stopPriceMicros,
        }
        const pendingMaterial = {
          ...closeFacts.brokerState,
          positions: closeFacts.brokerState.positions.map((position) => ({
            ...position,
            quantityAtoms: remainingQuantity,
            ...(keepNative
              ? {
                  costBasisMicros: String(BigInt(position.costBasisMicros) - BigInt(partialBasis)),
                  marketValueMicros: String(
                    (BigInt(position.marketPriceMicros) * BigInt(remainingQuantity)) / 1_000_000_000n,
                  ),
                  unrealizedPnlMicros: String(
                    (BigInt(position.marketPriceMicros) * BigInt(remainingQuantity)) / 1_000_000_000n -
                      (BigInt(position.costBasisMicros) - BigInt(partialBasis)),
                  ),
                }
              : {}),
          })),
          orders: [...closeFacts.brokerState.orders, child, ...(keepNative ? [remainingStop] : [])],
        }
        const pendingHash = Result.getOrThrow(reconciledStateHash(pendingMaterial))
        const pendingReconciliation = {
          ...pendingMaterial.reconciliation,
          reconciliationId: '6'.repeat(64),
          expectedHash: pendingHash,
          observedHash: pendingHash,
          contentHash: Result.getOrThrow(canonicalHashV1Result(pendingMaterial)),
          reconciledAt: cancelAt,
        }
        yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,
          content_hash,status,discrepancies,reconciled_at) VALUES (${pendingReconciliation.reconciliationId},
          ${pendingReconciliation.schemaVersion},${replayAccountId},${pendingHash},${pendingHash},
          ${pendingReconciliation.contentHash},'EXACT','[]'::jsonb,${cancelAt})`
        const pendingFacts: ReconciliationPassResult = {
          ...closeFacts,
          brokerState: { ...pendingMaterial, reconciliation: pendingReconciliation },
          report: { ...closeFacts.report, reconciliation: pendingReconciliation },
        }
        let fenceCalls = 0
        let brokerCalls = 0
        const lostAck = new WriterFenceError({
          failure: 'unavailable',
          operation: 'transaction',
          message: 'injected cancel receipt acknowledgement loss',
        })
        const cancelFence: WriterFenceService = {
          check: fence.check,
          transaction: (effect, finalize) =>
            Effect.suspend(() => {
              fenceCalls += 1
              if (fenceCalls !== 2) return fence.transaction(effect, finalize)
              return scenario === 'protection-committed-ack-loss'
                ? fence.transaction(effect, finalize).pipe(Effect.andThen(Effect.fail(lostAck)))
                : Effect.fail(lostAck)
            }),
        }
        const cancelStore = yield* IntentStore.pipe(
          Effect.provide(
            IntentStoreLive.pipe(
              Layer.provide(Layer.succeed(WriterFence, cancelFence)),
              Layer.provide(Layer.succeed(PgClient.PgClient, sql)),
              Layer.fresh,
            ),
          ),
        )
        const authority = Result.getOrThrow(
          makeExecutionAuthority({
            brokerIdentity: Result.getOrThrow(
              makeBrokerIdentity({
                schemaVersion: 'bayn.broker-identity.v2',
                provider: BrokerProvider.Alpaca,
                environment: BrokerEnvironment.Sandbox,
                accountId: replayAccountId,
              }),
            ),
            brokerAccess: BrokerAccess.Mutation,
            capitalAuthority: grantedCapitalAuthority(nativeInput.authorityGenerationHash),
            strategy: retainedRuntime.provenance.strategy,
            observedAt: cancelAt,
          }),
        )
        const mutations = yield* MutationStore
        const makeProgram = (store: typeof cancelStore, writer: WriterFenceService) =>
          Result.getOrThrow(
            makeExecutionProgram(authority, {
              brokerStateCache: makeBrokerStateCache(replayAccountId, nativeInput.authorityGenerationHash),
              brokerRead: broker,
              brokerMutation: {
                submit: () => Effect.die('Protection cancellation cannot submit an order'),
                cancel: (orderId) =>
                  Effect.sync(() => {
                    brokerCalls += 1
                    expect(orderId).toBe(brokerOrderId)
                    return {
                      brokerOrderId: orderId,
                      requestHash: Result.getOrThrow(
                        canonicalHashV1Result({ operation: MutationOperation.Cancel, brokerOrderId: orderId }),
                      ),
                      evidence: {
                        requestId: 'partial-tp-cancel',
                        status: 204,
                        contentHash: Result.getOrThrow(canonicalHashV1Result(null)),
                        observedAt: cancelAt,
                      },
                    }
                  }),
              },
              intentStore: store,
              mutationStore: mutations,
              writerFence: writer,
              riskPolicy: closeRequest.policy,
              verifyBrokerStateVersion: () => Effect.die('Cancellation cannot authorize a submission'),
              readFinalExecutionRiskContext: () => Effect.die('Cancellation cannot authorize a submission'),
              persistedCapitalGrants: {
                read: () => Effect.die('Unexpected grant read'),
                lockForSubmit: () => Effect.die('Unexpected grant lock'),
              },
              currentUtcInstant: Clock.currentTimeMillis.pipe(Effect.map(utcInstantFromEpochMillis)),
            }),
          )
        const advance = (program: ReturnType<typeof makeProgram>, facts: ReconciliationPassResult) =>
          advancePositionProtection({
            input: keepNative
              ? {
                  ...closeRequest.input,
                  intradayMarketData: {
                    ...marketData,
                    loadSnapshot: (query) =>
                      Effect.succeed(
                        streamingFixtureFromRaw(
                          makeIntradayMomentumTestSnapshot(
                            fixture.protocol,
                            { ...query, archiveWatermarks: [] },
                            { AAPL: 0.002 },
                          ),
                          query,
                        ).snapshot,
                      ),
                  },
                }
              : closeRequest.input,
            cycle,
            document,
            protocol: fixture.protocol,
            policy: closeRequest.policy,
            reconciliation: facts,
            capability: { _tag: 'Mutation', executionProgram: program },
            closeDue: false,
            closeExpiresAt: cycle.window.executionCloseAt,
          })
        const first = yield* advance(makeProgram(cancelStore, cancelFence), pendingFacts)
        if (keepNative) {
          const current = yield* (yield* JevPositionStore).read({
            cycleId: cycle.identity.cycleId,
            entryDecisionHash: document.contentHash,
            brokerState: pendingFacts.brokerState,
          })
          expect(current).toMatchObject({
            protectionEvidenceVersion: 'bayn.jev-protection-evidence.v2',
            exitRequestedAt: null,
            profitExitRequested: false,
            protectionDisposals: { quantityAtoms: '2000000000', costBasisMicros: partialBasis },
          })
          expect(first).toMatchObject({ _tag: 'Step', step: { _tag: 'Wait', waitReason: 'JEV_POSITION_HELD' } })
          expect(brokerCalls).toBe(0)
          expect(yield* sql`SELECT count(*)::integer AS count FROM native_protection_cancel_commands`).toEqual([
            { count: 0 },
          ])
          expect(yield* sql`SELECT count(*)::integer AS count FROM autonomous_cycle_paper_closures`).toEqual([
            { count: 0 },
          ])
          return
        }
        expect(fenceCalls).toBe(2)
        expect(first._tag).toBe(scenario === 'protection-committed-ack-loss' ? 'PostMutationReconciliation' : 'Step')
        expect(brokerCalls).toBe(1)
        expect(yield* sql`SELECT count(*)::integer AS count FROM autonomous_cycle_paper_closures`).toEqual([
          { count: 0 },
        ])
        yield* Effect.acquireUseRelease(
          Effect.sync(() => postgres.makeAdditionalRuntime()),
          (restarted) =>
            Effect.promise(() =>
              restarted.runPromise(
                Effect.gen(function* () {
                  yield* TestClock.setTime(Date.parse(cancelAt) + 1_000)
                  const recoveredStore = yield* IntentStore
                  const recoveredFence = yield* WriterFence
                  const recovered = yield* advance(makeProgram(recoveredStore, recoveredFence), pendingFacts)
                  if (recovered._tag !== 'Step' || recovered.step._tag !== 'Wait')
                    throw new Error('Expected durable cancellation publication wait')
                  if (recovered.step.waitReason === undefined) throw new Error('Expected cancellation wait reason')
                  const accepted = scenario === 'protection-committed-ack-loss'
                  expect(recovered.step.waitReason).toBe(
                    accepted ? 'PROTECTION_PUBLICATION_PENDING' : 'PROTECTION_CANCEL_PENDING',
                  )
                  const delay =
                    executionEvidenceContinuationDelayMs(
                      {
                        outcome: 'RECOVERED',
                        action: 'WAITING',
                        cycle,
                        observedAt: recovered.step.observedAt,
                        waitReason: recovered.step.waitReason,
                      },
                      30_000,
                      recovered.step.observedAt,
                    ) ?? 30_000
                  expect(delay).toBe(accepted ? 5_000 : 30_000)
                  expect(brokerCalls).toBe(1)
                  const recoveredSql = yield* PgClient.PgClient
                  expect(
                    yield* recoveredSql`SELECT count(*)::integer AS count FROM native_protection_cancel_commands`,
                  ).toEqual([{ count: 1 }])
                  expect(
                    yield* recoveredSql`SELECT count(*)::integer AS count FROM native_protection_cancel_receipts`,
                  ).toEqual([{ count: accepted ? 1 : 0 }])
                  expect(
                    yield* recoveredSql`SELECT count(*)::integer AS count FROM autonomous_cycle_paper_closures`,
                  ).toEqual([{ count: 0 }])
                  if (!accepted) return
                  const publishedAt = new Date(Date.parse(cancelAt) + 5_000).toISOString()
                  yield* TestClock.setTime(Date.parse(publishedAt))
                  const remainingMaterial = {
                    ...pendingFacts.brokerState,
                    account: { ...pendingFacts.brokerState.account, observedAt: publishedAt },
                    positions: pendingFacts.brokerState.positions.map((position) => ({
                      ...position,
                      observedAt: publishedAt,
                    })),
                    orders: [
                      ...closeFacts.brokerState.orders.map((order) => ({ ...order, observedAt: publishedAt })),
                      { ...child, status: OrderStatus.Canceled, observedAt: publishedAt },
                    ],
                    positionsObservedAt: publishedAt,
                    ordersObservedAt: publishedAt,
                  }
                  const publishedHash = Result.getOrThrow(reconciledStateHash(remainingMaterial))
                  const publishedReconciliation = {
                    ...remainingMaterial.reconciliation,
                    reconciliationId: '5'.repeat(64),
                    expectedHash: publishedHash,
                    observedHash: publishedHash,
                    contentHash: Result.getOrThrow(canonicalHashV1Result(remainingMaterial)),
                    reconciledAt: publishedAt,
                  }
                  yield* recoveredSql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,
              content_hash,status,discrepancies,reconciled_at) VALUES (${publishedReconciliation.reconciliationId},
              ${publishedReconciliation.schemaVersion},${replayAccountId},${publishedHash},${publishedHash},
              ${publishedReconciliation.contentHash},'EXACT','[]'::jsonb,${publishedAt})`
                  yield* recoveredSql`UPDATE simulated_execution_clocks SET observed_at=${publishedAt} WHERE account_id=${replayAccountId}`
                  const publishedFacts: ReconciliationPassResult = {
                    ...pendingFacts,
                    brokerState: { ...remainingMaterial, reconciliation: publishedReconciliation },
                    report: { ...pendingFacts.report, reconciliation: publishedReconciliation },
                  }
                  const inexact = yield* advance(makeProgram(recoveredStore, recoveredFence), {
                    ...publishedFacts,
                    report: {
                      ...publishedFacts.report,
                      metrics: { ...publishedFacts.report.metrics, accountingExact: false },
                    },
                  })
                  if (inexact._tag !== 'Step' || inexact.step._tag !== 'Wait' || inexact.step.waitReason === undefined)
                    throw new Error('Expected inexact publication to retain reconciliation wait')
                  expect(inexact.step.waitReason).toBe('PROTECTION_AWAITING_RECONCILIATION')
                  expect(
                    executionEvidenceContinuationDelayMs(
                      {
                        outcome: 'RECOVERED',
                        action: 'WAITING',
                        cycle,
                        observedAt: inexact.step.observedAt,
                        waitReason: inexact.step.waitReason,
                      },
                      30_000,
                      inexact.step.observedAt,
                    ) ?? 30_000,
                  ).toBe(30_000)
                  expect(
                    yield* recoveredSql`SELECT count(*)::integer AS count FROM autonomous_cycle_paper_closures`,
                  ).toEqual([{ count: 0 }])
                  const ready = yield* advance(makeProgram(recoveredStore, recoveredFence), publishedFacts)
                  if (ready._tag !== 'Ready' || ready.exitTarget === undefined)
                    throw new Error('Expected exact publication to release residual exit')
                  const residual = yield* prepareClosingExecutionCycleDecision({
                    ...closeRequest,
                    reconcile: Effect.succeed(publishedFacts),
                    initialReconciliation: publishedFacts,
                    exitTarget: ready.exitTarget,
                  })
                  expect(
                    residual.document.targetPlan.intentTargets.map(({ side, quantityAtoms }) => ({
                      side,
                      quantityAtoms,
                    })),
                  ).toEqual([{ side: OrderSide.Sell, quantityAtoms: '3000000000' }])
                  expect(residual.document.orderedIntentIds).toHaveLength(1)
                  const closure = Result.getOrThrow(
                    makeExecutionCycleClosure({
                      schemaVersion: 'bayn.paper-cycle-closure.v1',
                      cycleId: nativeInput.cycleId,
                      entryDecisionHash: document.contentHash,
                      document: residual.document,
                      createdAt: residual.document.createdAt,
                      expiresAt: residual.document.expiresAt,
                    }),
                  )
                  const closures = yield* ExecutionCycleClosureStore
                  expect(yield* closures.bind(closure)).toEqual(closure)
                  expect(yield* closures.bind(closure)).toEqual(closure)
                  expect(
                    Option.getOrThrow(yield* closures.read(nativeInput.cycleId)).document.orderedIntentIds,
                  ).toEqual(residual.document.orderedIntentIds)
                  expect(
                    yield* recoveredSql`SELECT count(*)::integer AS count FROM autonomous_cycle_paper_closures`,
                  ).toEqual([{ count: 1 }])
                  expect(brokerCalls).toBe(1)
                }).pipe(Effect.provideService(BrokerRead, broker), Effect.provide(TestClock.layer())),
              ),
            ),
          (restarted) => Effect.promise(() => restarted.dispose()),
        )
        return
      }
      const close = yield* prepareClosingExecutionCycleDecision(closeRequest).pipe(
        Effect.tapError((error) => Effect.logError(error)),
      )
      expect(close.document.dispatchable).toBe(true)
      expect(close.document.strategyDecision).toEqual(exitTarget)
      expect(
        close.document.targetPlan.intentTargets.map(({ side, quantityAtoms }) => ({ side, quantityAtoms })),
      ).toEqual([{ side: OrderSide.Sell, quantityAtoms: '5000000000' }])
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
      const verifyAdmissionReceipt = (bound: ExecutionDecisionDocument) =>
        Effect.gen(function* () {
          const intentId = bound.orderedIntentIds[0]
          const target = bound.targetPlan.intentTargets[0]
          const risk = bound.deltaRisk[0]
          if (intentId === undefined || target === undefined || risk === undefined)
            throw new Error('Expected a native close admission target')
          const eventId = Result.getOrThrow(canonicalHashV1Result({ admitted: bound.contentHash }))
          const attempted = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO intents(intent_id, schema_version, account_id, client_order_id, symbol, side,
            order_type, time_in_force, quantity_atoms, notional_limit_micros, limit_price_micros, state,
            created_at, updated_at, cycle_id, strategy_name, decision_hash, policy_hash, authority_generation_hash)
            VALUES (${intentId}, 'bayn.execution-intent.v5', ${replayAccountId}, ${clientOrderIdForIntentId(intentId)},
              ${target.symbol}, ${target.side}, ${target.orderType}, ${target.timeInForce}, ${target.quantityAtoms},
              ${risk.notionalLimitMicros}, ${risk.limitPriceMicros}, 'PLANNED', ${bound.createdAt}, ${bound.createdAt},
              ${nativeInput.cycleId}, 'jev', ${bound.bindings.strategyDecisionHash}, ${bound.bindings.policyHash},
              ${nativeInput.authorityGenerationHash})`
                yield* sql`INSERT INTO mutation_events(event_id, schema_version, mutation_id, intent_id, sequence,
            operation, event_type, request_hash, consistency_delay_ms, occurred_at)
            VALUES (${eventId}, 'bayn.paper-mutation-event.v1', ${eventId}, ${intentId}, 1,
              'SUBMIT', 'SUBMIT_STARTED', ${eventId}, 1000, ${bound.createdAt})`
                expect(
                  yield* sql`SELECT decision_id FROM execution_decision_admissions WHERE event_id = ${eventId}`,
                ).toEqual([{ decision_id: bound.contentHash }])
                return yield* Effect.fail('roll back the test admission while retaining its real native source')
              }),
            )
            .pipe(Effect.result)
          expect(Result.isFailure(attempted)).toBe(true)
          expect(
            yield* sql`SELECT count(*)::integer AS count FROM execution_decision_admissions WHERE event_id = ${eventId}`,
          ).toEqual([{ count: 0 }])
        })
      yield* sql`UPDATE simulated_execution_clocks SET observed_at = ${closure.createdAt}
      WHERE account_id = ${replayAccountId}`
      const expired = yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(exitTarget.commitDeadlineAt))
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
        const clock = yield* makeSimulatedExecutionClock('e'.repeat(64), 'e'.repeat(64), providerClock)
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          measureDatabaseTime: clock.measure,
          providerClock,
          providers: {
            jev: entryProviderFixture(
              { evaluate: () => Effect.die('Exit persistence must use its recorded evidence') },
              chartProviderFixture,
            ),
          },
          advanceTo: (atMs) =>
            clock
              .advanceTo(utcInstantFromEpochMillis(atMs))
              .pipe(Effect.andThen(TestClock.setTime(atMs)), Effect.orDie),
          advanceDeadlineTo: (atMs) =>
            clock
              .advanceTo(utcInstantFromEpochMillis(atMs))
              .pipe(Effect.andThen(TestClock.setTime(atMs)), Effect.orDie),
          excludedSourceMillis: clock.excludedSourceMillis,
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
      yield* verifyAdmissionReceipt(saved.document)
      yield* TestClock.setTime(Date.parse(exitTarget.observedAt) + 60_000)
      expect(yield* store.bind(closure)).toEqual(saved)
      expect(Option.getOrThrow(yield* store.read(nativeInput.cycleId))).toEqual(saved)
      expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
      const closeWindow = {
        startAt: new Date(Date.parse(cycle.window.executionCloseAt) - 300_000).toISOString(),
        submitCutoffAt: cycle.window.executionCloseAt,
        expiresAt: cycle.window.executionCloseAt,
      }
      const recovered = yield* ensureExecutionCycleClosure({
        input: { ...closeRequest.input, executionCycleClosureStore: store },
        preparation: closeRequest.preparation,
        policy: closeRequest.policy,
        cycle,
        entryDocument: document,
        closeWindow,
        reconcile: Effect.die('Existing unsubmitted close unexpectedly reconciled'),
        refreshReconciliation: Effect.die('An unsubmitted close has no terminal state to refresh'),
        existing: Option.getOrUndefined(yield* store.read(nativeInput.cycleId)),
      })
      expect(recovered).toEqual({ _tag: 'Close', document: close.document })
      const remainingAt = new Date(yield* Clock.currentTimeMillis).toISOString()
      const remainingMaterial = {
        ...portfolio.brokerState,
        account: { ...portfolio.brokerState.account, observedAt: remainingAt },
        positions: portfolio.brokerState.positions.map((position) => ({
          ...position,
          quantityAtoms: '3000000000',
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
        contentHash: Result.getOrThrow(canonicalHashV1Result(remainingMaterial)),
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
      expect(residual.document.targetPlan.intentTargets.map(({ quantityAtoms }) => quantityAtoms)).toEqual([
        '3000000000',
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
      yield* verifyAdmissionReceipt(replan.document)
      expect(yield* store.bindReplan(replan)).toEqual(replan)
      expect(Option.getOrThrow(yield* store.readLatestReplan(nativeInput.cycleId))).toEqual(replan)
      const recoveredReplan = yield* ensureExecutionCycleClosure({
        input: { ...closeRequest.input, executionCycleClosureStore: store },
        preparation: closeRequest.preparation,
        policy: closeRequest.policy,
        cycle,
        entryDocument: document,
        closeWindow,
        reconcile: Effect.die('Existing unsubmitted residual close unexpectedly reconciled'),
        refreshReconciliation: Effect.die('An unsubmitted residual close has no terminal state to refresh'),
        existing: Option.getOrUndefined(yield* store.read(nativeInput.cycleId)),
      })
      expect(recoveredReplan).toEqual({ _tag: 'Close', document: residual.document })
      expect(calls).toBe(equityMarketProfile.candidateSymbols.length)
    }).pipe(
      Effect.provideService(BrokerRead, broker),
      Effect.provideService(
        JevClient,
        entryProviderFixture({
          evaluate: (request) =>
            Effect.gen(function* () {
              calls += 1
              if (calls === equityMarketProfile.candidateSymbols.length) yield* TestClock.setTime(observed + 7000)
              return nativeJevInference(
                request,
                new Date(yield* Clock.currentTimeMillis).toISOString(),
                calls <= equityMarketProfile.candidateSymbols.length,
              )
            }),
        }),
      ),
      atObservation,
    ),
  )
}
