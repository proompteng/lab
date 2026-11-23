import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Clock, Effect, Exit, Layer, ManagedRuntime, Redacted } from 'effect'
import { TestClock } from 'effect/testing'
import { BrokerRead, type BrokerReadShape } from '../broker/alpaca/model'
import { BrokerEnvironment } from '../broker/identity'
import { sourceTimestamp, type FillEventInput } from '../broker/observations'
import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { DecisionConstruction } from '../decision-construction'
import {
  Authority,
  KillState,
  OrderSide,
  Broker,
  OrderType,
  TimeInForce,
  RiskOutcome,
  intentPlanSchemaVersion,
  type Position,
} from '../execution/contracts'
import { clientOrderIdForIntentId, planExecutionIntent } from '../execution/intents/domain'
import { evaluate } from '../risk'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { makeExecutionRiskPolicy } from '../execution/risk-policy'
import { WriterFenceLive } from '../execution/writer-fence'
import { canonicalHashV1Result, sha256 } from '../hash'
import { JevClient } from '../jev/client'
import { decodeJevResponse, prepareJevRequest } from '../jev/contract'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { nativeJevFixture } from '../jev/native.test-support'
import { buildMutationShadowCycleDecision } from '../observe-composition/decision-builder'
import { constructExecutionDecision, constructObserveShadowDecision } from '../shadow-decision'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { fixtureRuntime, config as baseConfig } from '../testing/runtime-fixtures'
import { shortEntryBrokerReads } from '../testing/entry-broker-reads.test-support'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { Journal, JournalLive } from '../ledger'
import { rebuildAccountingLedger } from '../accounting/domain'
import { Schema } from 'effect'
import { AccountingTransactionRowSchema, accountingTransactionFromRow } from './accounting-rows'
import { makeExecutionPersistence } from './execution-store/postgres'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { IntentStore } from '../execution/intents/domain'
import { IntentStoreLive } from '../execution/intents/postgres'
import { CycleObservability, CycleObservabilityLive } from '../cycle/store/observability'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://agent@127.0.0.1:55432/bayn_v41_test'
const accountId = `replay-${sha256(crypto.randomUUID())}`
const native = nativeJevFixture(
  undefined,
  undefined,
  accountId,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  true,
)
const at = native.snapshot.manifest.observedAt
const generation = native.input.authorityGenerationHash

integration('native equity short PostgreSQL execution', () => {
  const makeRuntime = () =>
    ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(DecisionConstruction, {
          observe: constructObserveShadowDecision,
          execution: constructExecutionDecision,
        }),
        CandidateObservationStoreLive,
        JevBatchStoreLive,
        EntryInferenceJournalLive,
        CycleStoreLive,
        IntentStoreLive,
        CycleObservabilityLive,
      ).pipe(
        Layer.provideMerge(JevEvaluationStoreLive),
        Layer.provideMerge(WriterFenceLive),
        Layer.provideMerge(
          PostgresClientLive({
            operationTimeoutMs: 5000,
            postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    )
  let database: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Native short integration requires an isolated local _test database')
    database = makeRuntime()
  })
  afterAll(async () => {
    await database?.dispose()
  })

  test.each(baynTestTigerBeetleAddress === undefined ? [false] : [false, true])(
    'bearish native inference binds a dispatchable SELL and rejects substituted short protection; real ledger=%s',
    async (realLedger) => {
      const state = native.portfolio.brokerState
      const snapshots = [native.snapshot]
      const unused = Effect.die('Unexpected broker read')
      const read: BrokerReadShape = {
        ...shortEntryBrokerReads(state.account, at),
        positions: unused,
        orders: () => unused,
        orderById: () => unused,
        orderByClientId: () => unused,
        feeActivities: () => unused,
        fillActivities: () => unused,
        marketCalendar: () =>
          Effect.succeed({
            value: native.snapshot.manifest.calendar,
            evidence: { requestId: 'short-calendar', status: 200, contentHash: 'f'.repeat(64), observedAt: at },
          }),
      }
      await database.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(at))
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* postgresMigrations
          const initialAt = new Date(Date.parse(at) - 1000).toISOString()
          yield* sql`INSERT INTO simulated_execution_clocks(account_id,source_manifest_hash,observed_at)
          VALUES (${accountId},${'e'.repeat(64)},${at})`
          yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,activated_at)
          VALUES (${'d'.repeat(64)},'bayn.authority-generation-history.v1','OBSERVE',1,${initialAt})`
          const r = state.reconciliation
          yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
          VALUES (${r.reconciliationId},${r.schemaVersion},${accountId},${r.expectedHash},${r.observedHash},${r.contentHash},'EXACT','[]'::jsonb,${at})`
          const policy = yield* Effect.fromResult(
            makeExecutionRiskPolicy(accountId, native.protocol.universe, BrokerEnvironment.Sandbox),
          )
          const policyHash = yield* Effect.fromResult(canonicalHashV1Result(policy))
          yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,activation_schema_version,
          previous_generation_hash,maximum,authority_version,activation_source_revision,activation_image_repository,
          activation_image_digest,strategy_name,strategy_behavior_hash,strategy_parameter_hash,strategy_parameter_schema_version,
          strategy_protocol_hash,account_id,broker_identity_schema_version,broker_identity_hash,broker_provider,broker_environment,
          risk_policy_hash,proof_plan_hash,reconciliation_id,reconciliation_content_hash,research_plan_hash,activated_at)
          VALUES (${generation},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',${'d'.repeat(64)},
          'PAPER',2,${fixtureRuntime.provenance.sourceRevision},${fixtureRuntime.provenance.image.repository},${fixtureRuntime.provenance.image.digest},
          'jev',${fixtureRuntime.provenance.strategy.behaviorHash},${fixtureRuntime.provenance.strategy.parameterHash},${native.protocol.schemaVersion},
          ${native.draft.identity.strategyProtocolHash},${accountId},'bayn.broker-identity.v2',${'9'.repeat(64)},'alpaca','sandbox',
          ${policyHash},${'8'.repeat(64)},${r.reconciliationId},${r.contentHash},${'7'.repeat(64)},${at})`
          yield* sql`INSERT INTO authority_state(schema_version,generation_hash,maximum,effective,kill_state,reason,version,updated_at)
          VALUES ('bayn.paper-authority.v1',${'d'.repeat(64)},'OBSERVE','OBSERVE','CLEAR',NULL,1,${initialAt})`
          yield* sql`UPDATE authority_state SET generation_hash=${generation},maximum='PAPER',effective='PAPER',version=2,updated_at=${at} WHERE singleton`
          yield* sql`INSERT INTO valuations(valuation_id,schema_version,account_id,source_hash,cash_micros,
          long_market_value_micros,short_market_value_micros,equity_micros,as_of)
          VALUES (${'6'.repeat(64)},'bayn.paper-valuation.v1',${accountId},${'5'.repeat(64)},${state.account.equityMicros},0,0,${state.account.equityMicros},${at})`
          const cycles = yield* CycleStore
          yield* cycles.acquire(native.draft, at)
          const { cycle } = yield* cycles.activate(native.draft.identity.cycleId, at)
          const document = yield* buildMutationShadowCycleDecision({
            authorityGenerationHash: generation,
            cycle,
            executionModel: native.protocol.executionModel,
            strategy: fixtureRuntime,
            policy,
            reconcile: Effect.succeed({
              brokerState: state,
              report: {
                reconciliation: r,
                metrics: {
                  accountingExact: true,
                  discrepancyCount: 0,
                  brokerPollAgeMs: 0,
                  oldestUnknownMutationAgeMs: 0,
                  cashDifferenceMicros: '0',
                  positionDifferenceMicros: '0',
                  equityDifferenceMicros: '0',
                },
              },
              riskContext: {
                tradingDate: native.snapshot.manifest.sessionDate,
                authority: {
                  schemaVersion: 'bayn.paper-authority.v1',
                  generationHash: generation,
                  maximum: Authority.Execution,
                  effective: Authority.Execution,
                  kill: KillState.Clear,
                  version: 2,
                  updatedAt: at,
                },
                authorityObservedAt: at,
                unknownMutationCount: 0,
                dailyTradedNotionalMicros: '0',
                dayStartEquityMicros: state.account.equityMicros,
                peakEquityMicros: state.account.equityMicros,
              },
            }),
            intradayMarketData: {
              check: Effect.void,
              verifyReference: fixtureStreamingReference,
              loadSnapshot: (query) =>
                Effect.sync(() => {
                  const snapshot =
                    query.purpose === undefined
                      ? native.snapshot
                      : streamingFixtureFromRaw(
                          makeIntradayMomentumTestSnapshot(
                            native.protocol,
                            { ...query, archiveWatermarks: [] },
                            { AAPL: 0.02 },
                          ),
                          query,
                        ).snapshot
                  snapshots.push(snapshot)
                  return snapshot
                }),
            },
          })
          expect(document.dispatchable).toBe(true)
          expect(document.strategyDecision?.schemaVersion).toBe('bayn.jev-entry-target.v7')
          expect(document.targetPlan.intentTargets).toHaveLength(1)
          const target = document.targetPlan.intentTargets[0]
          const risk = document.deltaRisk[0]
          const intentId = document.orderedIntentIds[0]
          if (target === undefined || risk === undefined || intentId === undefined || risk.protection === undefined)
            throw new Error('Expected the genuine native short intent')
          expect(target.side).toBe(OrderSide.Sell)
          expect(risk.protection._tag).toBe('EquityShortBracket')
          const references = yield* Effect.forEach(snapshots, fixtureStreamingReference)
          yield* cycles.bindDecision(cycle.identity.cycleId, document, document.createdAt, {
            streamingSnapshotReferences: references.filter(
              (ref) => ref.schemaVersion === 'bayn.streaming-snapshot-reference.v1',
            ),
          })
          const insert = (side: string, quantity: string, protection: typeof risk.protection) =>
            sql`INSERT INTO intents(intent_id,schema_version,account_id,client_order_id,symbol,side,order_type,time_in_force,
            quantity_atoms,notional_limit_micros,limit_price_micros,state,created_at,updated_at,cycle_id,strategy_name,
            decision_hash,policy_hash,authority_generation_hash,protection)
          VALUES (${intentId},'bayn.execution-intent.v5',${accountId},${clientOrderIdForIntentId(intentId)},${target.symbol},${side},
            ${target.orderType},${target.timeInForce},${quantity},${risk.notionalLimitMicros},${risk.limitPriceMicros},'PLANNED',
            ${document.createdAt},${document.createdAt},${cycle.identity.cycleId},'jev',${document.bindings.strategyDecisionHash},
            ${document.bindings.policyHash},${generation},${sql.json(protection)})`
          if (risk.protection._tag !== 'EquityShortBracket') throw new Error('Expected short protection')
          const shortProtection = risk.protection
          for (const mutation of [
            { side: 'BUY', quantity: target.quantityAtoms, protection: risk.protection },
            { side: 'SELL', quantity: '1000000001', protection: risk.protection },
            {
              side: 'SELL',
              quantity: target.quantityAtoms,
              protection: {
                ...risk.protection,
                stopPriceMicros: (BigInt(risk.protection.stopPriceMicros) + 1n).toString(),
              },
            },
          ]) {
            const changed = yield* sql
              .withTransaction(insert(mutation.side, mutation.quantity, mutation.protection))
              .pipe(Effect.exit)
            expect(Exit.isFailure(changed)).toBe(true)
            if (Exit.isFailure(changed))
              expect(Cause.pretty(changed.cause)).toContain('native short protection must bind')
          }
          yield* insert(target.side, target.quantityAtoms, risk.protection)
          const cancellationAt = new Date(Date.parse(document.createdAt) + 1).toISOString()
          const providerUpdatedAt = yield* Effect.fromResult(sourceTimestamp(cancellationAt))
          for (const side of [OrderSide.Buy, OrderSide.Sell]) {
            const brokerOrderId = `short-protective-${side}`
            const eventId = yield* Effect.fromResult(canonicalHashV1Result({ intentId, brokerOrderId }))
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
                source_event_id,source_sequence,occurred_at,observed_at)
                VALUES(${eventId},'bayn.paper-broker-event.v1',${eventId},'ORDER','ALPACA',${accountId},
                  ${`order:${brokerOrderId}:${providerUpdatedAt}`},${side === OrderSide.Buy ? 1 : 2},${cancellationAt},${cancellationAt})`
                yield* sql`INSERT INTO orders(event_id,account_id,schema_version,broker_order_id,client_order_id,intent_id,
                symbol,side,order_type,time_in_force,quantity_atoms,filled_quantity_atoms,limit_price_micros,stop_price_micros,status,
                broker_updated_at)
                VALUES(${eventId},${accountId},'bayn.order.v3',${brokerOrderId},${brokerOrderId},${intentId},
                  ${target.symbol},${side},'STOP_LIMIT','DAY',${target.quantityAtoms},0,
                  ${shortProtection.stopLimitPriceMicros},${shortProtection.stopPriceMicros},'NEW',${providerUpdatedAt})`
              }),
            )
            const store = yield* IntentStore
            if (side === OrderSide.Buy) {
              const beforeObservation = new Date(yield* Clock.currentTimeMillis).toISOString()
              expect(Date.parse(beforeObservation)).toBeLessThan(Date.parse(cancellationAt))
              expect(
                (yield* store.beginProtectionCancel(intentId, brokerOrderId, beforeObservation, undefined))._tag,
              ).toBe('NotEligible')
              yield* TestClock.setTime(Date.parse(cancellationAt))
              yield* sql`UPDATE simulated_execution_clocks SET observed_at=${cancellationAt}::timestamptz
                WHERE account_id=${accountId}`
              const futureCallerAt = new Date(Date.parse(cancellationAt) + 1).toISOString()
              expect(
                (yield* store.beginProtectionCancel(intentId, brokerOrderId, futureCallerAt, undefined))._tag,
              ).toBe('NotEligible')
              expect(
                yield* sql`SELECT count(*)::int AS count FROM native_protection_cancel_commands
                  WHERE intent_id=${intentId}`,
              ).toEqual([{ count: 0 }])
            }
            const admission = yield* store.beginProtectionCancel(intentId, brokerOrderId, cancellationAt, undefined)
            expect(admission._tag).toBe(side === OrderSide.Buy ? 'New' : 'NotEligible')
            if (side === OrderSide.Buy)
              expect(
                (yield* store.beginProtectionCancel(intentId, brokerOrderId, cancellationAt, undefined))._tag,
              ).toBe('PendingUnknown')
          }
          expect(
            yield* sql`SELECT side,protection->>'_tag' AS protection FROM intents WHERE intent_id=${intentId}`,
          ).toEqual([{ side: 'SELL', protection: 'EquityShortBracket' }])
          for (const kind of ['EquityShortOco', 'EquityShortStopLimit'] as const) {
            const protection =
              kind === 'EquityShortOco'
                ? { ...risk.protection, _tag: kind, entryDecisionHash: document.contentHash }
                : {
                    _tag: kind,
                    stopPriceMicros: risk.protection.stopPriceMicros,
                    entryDecisionHash: document.contentHash,
                  }
            const price =
              kind === 'EquityShortOco' ? risk.protection.profitLimitPriceMicros : risk.protection.stopLimitPriceMicros
            const protectionGeneration = yield* Effect.fromResult(
              canonicalHashV1Result({
                entryDecisionHash: document.contentHash,
                reconciliationId: r.reconciliationId,
                protection,
              }),
            )
            const orderType = kind === 'EquityShortOco' ? OrderType.Limit : OrderType.StopLimit
            if (risk.facts === undefined) throw new Error('Expected native entry risk facts')
            const protectiveIntent = yield* planExecutionIntent(
              {
                schemaVersion: intentPlanSchemaVersion,
                strategyName: 'jev',
                cycleId: cycle.identity.cycleId,
                decisionHash: document.bindings.strategyDecisionHash,
                policyHash: document.bindings.policyHash,
                accountId,
                symbol: target.symbol,
                side: OrderSide.Buy,
                orderType,
                timeInForce: TimeInForce.Day,
                quantityAtoms: '1000000000',
                limitPriceMicros: price,
                notionalLimitMicros: price,
                protection,
                replanGenerationHash: protectionGeneration,
                createdAt: document.createdAt,
              },
              { authority: risk.facts.state.authority },
            )
            const protectiveId = protectiveIntent.intentId
            const persist = (
              limit: string,
            ) => sql`INSERT INTO intents(intent_id,schema_version,account_id,client_order_id,symbol,side,order_type,time_in_force,
              quantity_atoms,notional_limit_micros,limit_price_micros,state,created_at,updated_at,cycle_id,strategy_name,
              decision_hash,policy_hash,authority_generation_hash,protection,replan_generation_hash)
              VALUES (${protectiveId},'bayn.execution-intent.v5',${accountId},${clientOrderIdForIntentId(protectiveId)},${target.symbol},'BUY',
              ${orderType},'DAY',1000000000,${limit},${limit},'PLANNED',${document.createdAt},${document.createdAt},${cycle.identity.cycleId},'jev',
              ${document.bindings.strategyDecisionHash},${document.bindings.policyHash},${generation},${sql.json(protection)},${protectionGeneration})`
            const changed = yield* sql.withTransaction(persist((BigInt(price) + 1n).toString())).pipe(Effect.exit)
            expect(Exit.isFailure(changed)).toBe(true)
            if (Exit.isFailure(changed))
              expect(Cause.pretty(changed.cause)).toContain('native short protection must bind')
            yield* persist(price)
            expect(yield* sql`SELECT side,order_type FROM intents WHERE intent_id=${protectiveId}`).toEqual([
              { side: 'BUY', order_type: orderType },
            ])
            const entryPrice = BigInt(risk.limitPriceMicros)
            const position: Position = {
              schemaVersion: 'bayn.position.v2',
              accountId,
              symbol: target.symbol,
              quantityAtoms: '-1000000000',
              averageEntryPriceMicros: entryPrice.toString(),
              costBasisMicros: (-entryPrice).toString(),
              marketPriceMicros: entryPrice.toString(),
              marketValueMicros: (-entryPrice).toString(),
              unrealizedPnlMicros: '0',
              observedAt: document.createdAt,
            }
            const held = {
              ...state,
              positions: [position],
              account: { ...state.account, cashMicros: (BigInt(state.account.equityMicros) + entryPrice).toString() },
            }
            const heldHash = yield* Effect.fromResult(reconciledStateHash(held))
            const { entryQuote: _entryQuote, equityShortEligibility: _eligibility, ...entryState } = risk.facts.state
            const protectiveRisk = yield* Effect.fromResult(
              evaluate({
                intent: protectiveIntent,
                policy,
                state: {
                  ...entryState,
                  account: held.account,
                  positions: held.positions,
                  reconciliation: { ...r, expectedHash: heldHash, observedHash: heldHash },
                  marketDataHash: protectionGeneration,
                  executionMarketDataHash: protectionGeneration,
                  referencePriceMicros: kind === 'EquityShortOco' ? price : risk.protection.stopPriceMicros,
                  expectedExecutionPriceMicros: price,
                  closeOnly: true,
                  closeOnlyExpiresAt: cycle.window.executionCloseAt,
                },
              }),
            )
            if (protectiveRisk.decision.outcome !== RiskOutcome.Approved)
              throw new Error(`${kind} risk rejected: ${protectiveRisk.decision.reasonCodes.join(',')}`)
            const decision = protectiveRisk.decision
            const approvedAt = new Date(Date.parse(document.createdAt) + 1).toISOString()
            const ioAt = new Date(Date.parse(document.createdAt) + 2).toISOString()
            const submittedAt = new Date(Date.parse(document.createdAt) + 3).toISOString()
            yield* sql`UPDATE simulated_execution_clocks SET observed_at=${submittedAt} WHERE account_id=${accountId}`
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO risk_decisions(decision_id,schema_version,input_hash,intent_id,policy_hash,outcome,reason_codes,decided_at,expires_at)
                VALUES (${decision.decisionId},${decision.schemaVersion},${decision.inputHash},${protectiveId},${decision.policyHash},${decision.outcome},
                ARRAY(SELECT jsonb_array_elements_text(${sql.json(decision.reasonCodes)})),${decision.decidedAt},${decision.expiresAt})`
                yield* sql`UPDATE intents SET state='APPROVED',risk_decision_id=${decision.decisionId},state_version=state_version+1,updated_at=${approvedAt} WHERE intent_id=${protectiveId}`
              }),
            )
            yield* sql`UPDATE intents SET state='IO_STARTED',state_version=state_version+1,updated_at=${ioAt} WHERE intent_id=${protectiveId}`
            const eventId = yield* Effect.fromResult(canonicalHashV1Result({ protectiveId, operation: 'SUBMIT' }))
            yield* sql`INSERT INTO mutation_events(event_id,schema_version,mutation_id,intent_id,sequence,operation,event_type,request_hash,consistency_delay_ms,occurred_at)
              VALUES (${eventId},'bayn.paper-mutation-event.v1',${eventId},${protectiveId},1,'SUBMIT','SUBMIT_STARTED',${eventId},1000,${submittedAt})`
            expect(yield* sql`SELECT decision_id FROM execution_decision_admissions WHERE event_id=${eventId}`).toEqual(
              [{ decision_id: document.contentHash }],
            )
          }
          if (realLedger) {
            if (baynTestTigerBeetleAddress === undefined || !/^127\.0\.0\.1:\d+$/.test(baynTestTigerBeetleAddress))
              throw new Error('Native short accounting requires isolated loopback TigerBeetle')
            const config = {
              ...baseConfig,
              operationTimeoutMs: 5000,
              tigerBeetle: { clusterId: 20912n, replicaAddresses: [baynTestTigerBeetleAddress], ledger: 71013 },
            }
            const openingPrice = BigInt(risk.limitPriceMicros)
            const total = BigInt(target.quantityAtoms)
            if (total < 2_000_000_000n) throw new Error('Partial cover fixture needs at least two whole shares')
            const events: FillEventInput[] = []
            for (const [index, [side, quantity, price]] of (
              [
                [OrderSide.Sell, total, openingPrice],
                [OrderSide.Buy, 1_000_000_000n, openingPrice - 1_000_000n],
                [OrderSide.Buy, total - 1_000_000_000n, openingPrice + 10_000_000n],
              ] as const
            ).entries()) {
              const occurredAt = new Date(Date.parse(at) + 1000 * (index + 1)).toISOString()
              const fill = {
                schemaVersion: 'bayn.fill.v2' as const,
                accountId,
                fillId: `native-short-fill-${index}`,
                brokerOrderId: `native-short-order-${index}`,
                clientOrderId: index === 0 ? clientOrderIdForIntentId(intentId) : `native-short-cover-${index}`,
                ...(index === 0 ? { intentId } : {}),
                symbol: target.symbol,
                side,
                quantityAtoms: quantity.toString(),
                priceAtoms: (price * 1000n).toString(),
                feeMicros: '10000',
                occurredAt,
              }
              events.push({
                _tag: 'Fill',
                broker: Broker.Alpaca,
                accountId,
                sourceEventId: fill.fillId,
                contentHash: yield* Effect.fromResult(canonicalHashV1Result(fill)),
                occurredAt,
                observedAt: occurredAt,
                sourceTimestamp: occurredAt.replace('Z', '000000Z'),
                fill,
              })
            }
            const post = (inputs: readonly FillEventInput[]) =>
              Effect.gen(function* () {
                const persistence = yield* makeExecutionPersistence(config)
                for (const event of inputs) yield* persistence.accounting.account(event)
              }).pipe(Effect.provide(JournalLive(config)))
            // Close and reopen the real ledger client after the opening and first partial cover.
            yield* post(events.slice(0, 2))
            yield* post(events)
            yield* post(events)
            const rows = yield* Schema.decodeUnknownEffect(Schema.Array(AccountingTransactionRowSchema))(
              yield* sql`SELECT * FROM accounting_transactions WHERE account_id=${accountId} ORDER BY occurred_at`,
            )
            expect(rows).toHaveLength(3)
            const observed = yield* (yield* CycleObservability).read(cycle.identity.qualificationRunId, accountId)
            expect(observed.economics?.accounting.realizedCloseCount).toBe(2)
            expect(rows.map((row) => row.schema_version)).toEqual(
              Array(3).fill('bayn.equity-short-accounting-transaction.v1'),
            )
            expect(rows.reduce((sum, row) => sum + BigInt(row.quantity_delta_atoms), 0n)).toBe(0n)
            expect(rows.reduce((sum, row) => sum + BigInt(row.cost_basis_delta_micros), 0n)).toBe(0n)
            const expectedPnl = 1_000_000n - ((total - 1_000_000_000n) * 10_000_000n) / 1_000_000_000n
            expect(rows.reduce((sum, row) => sum + BigInt(row.realized_pnl_micros), 0n)).toBe(expectedPnl)
            expect(rows.reduce((sum, row) => sum + BigInt(row.cash_delta_micros), 0n)).toBe(expectedPnl - 30_000n)
            const plans = yield* Effect.forEach(rows, (row) =>
              Effect.fromResult(rebuildAccountingLedger(accountingTransactionFromRow(row), config.tigerBeetle.ledger)),
            )
            expect(
              yield* Effect.gen(function* () {
                return yield* (yield* Journal).verifyAccount(accountId, plans)
              }).pipe(Effect.provide(JournalLive(config))),
            ).toBe(true)
          }
        }).pipe(
          Effect.provideService(BrokerRead, read),
          Effect.provideService(
            JevClient,
            entryProviderFixture({
              evaluate: (raw) =>
                Effect.gen(function* () {
                  const prepared = yield* Effect.fromResult(prepareJevRequest(raw))
                  const state = prepared.request.state
                  const selected =
                    typeof state === 'object' && state !== null && 'symbol' in state && state['symbol'] === 'AAPL'
                  const response = yield* Effect.fromResult(
                    decodeJevResponse(prepared.request, {
                      model: prepared.request.model,
                      answers: Object.fromEntries(
                        Object.keys(prepared.request.questions).map((name) => [
                          name,
                          {
                            type: 'noul',
                            noul:
                              selected &&
                              (name.includes('resistance_rejection') || name.includes('base_breakdown')) &&
                              !name.endsWith('_target_obstructed')
                                ? 0.9
                                : 0.1,
                          },
                        ]),
                      ),
                      usage: { input_tokens: 200, output_tokens: 0 },
                    }),
                  )
                  const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
                  return {
                    requestHash: prepared.requestHash,
                    responseHash: yield* Effect.fromResult(canonicalHashV1Result(response)),
                    startedAt: completedAt,
                    completedAt,
                    response,
                  }
                }).pipe(Effect.orDie),
            }),
          ),
          Effect.provide(TestClock.layer()),
        ),
      )
    },
    60_000,
  )
})
