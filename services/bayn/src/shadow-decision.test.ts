import { constructSimulatedSnapshot } from './market-data/streaming/snapshot'
import { reproduceRecordedStreamingDecision } from './market-data/streaming/recorded-decision'
import { streamingFixtureFromRaw } from './testing/streaming-market-fixture'
import { executionMarketDataBinding } from './observe-composition/intraday-market-data'
import { persistIntradayRecordRows } from './market-data/intraday/verification'
import { intradayMomentumPlanningTargetWeights } from './strategy/intraday-momentum/model'
import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted, Result, Schema } from 'effect'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'
import type { Statement } from 'effect/sql/Statement'
import { CycleStore, CycleStoreLive } from './cycle/store'
import { makeCycleQueries } from './cycle/store/queries'
import { DecisionEvidenceMismatch } from './cycle/store/model'
import { cycleDecisionStoreEvidence } from './cycle/store/decision-contract'
import { PostgresClientLive } from './db/postgres-client'
import { postgresMigrations } from './db/postgres-migrations'
import { baynTestPostgresUrl } from './test-environment.test-support'

import {
  CycleState,
  CycleTerminalReason,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type IntradayAutonomousCycle,
} from './cycle'
import {
  AccountStatus,
  Authority,
  IntentState,
  KillState,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  OrderSide as Side,
  TimeInForce,
  type AccountSnapshot,
  type Position,
  type Reconciliation,
} from './execution/contracts'
import { makeExecutionIntentFromDecodedPlan } from './execution/intents/domain'
import { IntentStore, planExecutionIntent, type StoredIntent } from './execution/intents'
import { MutationEventType, MutationStore, type MutationEvent, type MutationStoreShape } from './execution/mutations'
import { MutationOperation } from './broker/alpaca-mutations'
import { prepareMutationIntent } from './observe-composition/mutation-intent-interpreter'
import type { ReconciliationPassResult } from './reconciler'
import { legacyIntentPlanSchemaVersion } from './execution/legacy-wire'
import { bindCycleExecutionSession } from './execution-session'
import { canonicalHashV1 } from './hash'
import { IntradaySnapshotPurpose, type IntradaySnapshotRequest } from './market-data'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, Gate, PolicySchema, Reason, decodeState, evaluate, type Policy } from './risk'
import { strictParseOptions } from './schemas'
import {
  ActiveExecutionStages,
  ExecutionStageTimings,
  type ActiveExecutionStage,
  type ExecutionStageTiming,
} from './telemetry'
import {
  buildExecutionDecision,
  buildObserveShadowDecision,
  type ExecutionDecisionInput,
  type ObserveShadowDecisionInput,
  type ShadowDeltaRiskInput,
  type ShadowDecisionError,
} from './shadow-decision'
import {
  decodeExecutionDecisionDocument,
  decodeObserveShadowDecisionDocument,
  makeExecutionDecisionDocument,
  type CycleDecisionDocument,
} from './shadow-decision-contract'
import { decideIntradayMomentum } from './strategy/intraday-momentum/decision'
import { deriveIntradayMomentumSignalMetrics } from './strategy/intraday-momentum/decision-core'
import {
  decodeDefaultIntradayMomentumProtocol,
  intradayMomentumExecutionModel,
  intradayMomentumSnapshotSymbols,
} from './strategy/intraday-momentum/protocol'
import { makeIntradayMomentumTestSnapshot } from './strategy/intraday-momentum/test-support'
import {
  intradaySnapshotReferencePricesSchemaVersion,
  planTargets,
  quoteBoundTargetPlannerInputSchemaVersion,
  TargetPlanStatus,
  type QuoteBoundTargetPlannerInput,
} from './target-planner'

const hash = (character: string): string => character.repeat(64)
const accountId = 'paper-account-1'
const sessionDate = '2026-08-18' as const
const observedAt = '2026-08-18T16:00:02.000Z'
const brokerObservedAt = '2026-08-18T16:00:00.000Z'
const accountingHash = hash('a')

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: sessionDate, end: sessionDate },
  timeZone: 'UTC' as const,
  sessions: [
    {
      date: sessionDate,
      openAt: '2026-08-18T13:30:00.000Z',
      closeAt: '2026-08-18T20:00:00.000Z',
    },
  ],
}
const calendar = Object.freeze({ ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) })

const protocol = value(decodeDefaultIntradayMomentumProtocol())

const activeCycle = (account = accountId): IntradayAutonomousCycle => {
  const session = calendar.sessions[0]
  if (session === undefined) throw new Error('intraday test calendar requires one session')
  const executionCalendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: calendar.schemaVersion,
      source: calendar.source,
      ...session,
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
    throw new Error('intraday execution must derive a v3 cycle policy')
  }
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: hash('1'),
      strategyProtocolHash: hash('2'),
      accountId: account,
      executionSessionDate: sessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = value(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = value(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) throw new Error('intraday cycle must use v3')
  return {
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: '2026-08-18T13:00:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const snapshotRequest = (): IntradaySnapshotRequest => ({
  sessionDate,
  calendar,
  rangeStartAt: '2026-08-18T15:30:00.000Z',
  rangeEndAt: '2026-08-18T16:00:00.000Z',
  observedAt,
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  symbols: intradayMomentumSnapshotSymbols(protocol),
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: protocol.sourceTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1_000,
  archiveWatermarks: Object.values(protocol.sourceTopics)
    .sort()
    .map((sourceTopic) => ({ sourceTopic, sourcePartition: 0, inclusiveLastOffset: '1000' })),
})

const brokerState = (
  selectedAccountId = accountId,
  heldSymbol?: string,
  brokerObservedAt = '2026-08-18T16:00:00.000Z',
) => {
  const account: AccountSnapshot = {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId: selectedAccountId,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '100000000000',
    equityMicros: '100000000000',
    buyingPowerMicros: '100000000000',
    observedAt: brokerObservedAt,
  }
  const positions: Position[] =
    heldSymbol === undefined
      ? []
      : [
          {
            schemaVersion: 'bayn.paper-position.v1',
            accountId: selectedAccountId,
            symbol: heldSymbol,
            quantityMicros: '1000000',
            averageEntryPriceMicros: '100000000',
            marketPriceMicros: '100000000',
            marketValueMicros: '100000000',
            unrealizedPnlMicros: '0',
            observedAt: brokerObservedAt,
          },
        ]
  const orders = [] as const
  const stateHash = value(
    reconciledStateHash({
      account,
      positions,
      positionsObservedAt: brokerObservedAt,
      orders,
      ordersObservedAt: brokerObservedAt,
      accountingHash,
    }),
  )
  const reconciliationMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId: selectedAccountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt: brokerObservedAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material: reconciliationMaterial,
  })
  const reconciliation: Reconciliation = {
    ...reconciliationMaterial,
    reconciliationId,
    contentHash: canonicalHashV1({ ...reconciliationMaterial, reconciliationId }),
  }
  return {
    account,
    positions,
    positionsObservedAt: brokerObservedAt,
    orders,
    ordersObservedAt: brokerObservedAt,
    reconciliation,
    stateHash,
  }
}

const policy = (account = accountId): Policy =>
  Schema.decodeUnknownSync(
    PolicySchema,
    strictParseOptions,
  )({
    schemaVersion: 'bayn.execution-risk-policy.v3',
    accountId: account,
    brokerMode: BrokerMode.Execution,
    allowedSymbols: protocol.candidateSymbols,
    allowedOrderTypes: [OrderType.Limit],
    allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
    maxOrderNotionalMicros: '1000000000',
    maxSymbolExposureMicros: '1000000000',
    maxGrossExposureMicros: '1000000000',
    maxNetExposureMicros: '1000000000',
    maxDailyTradedNotionalMicros: '2000000000',
    maxDailyLossMicros: '100000000',
    maxDrawdownMicros: '100000000',
    maxIntentAgeMs: 120_000,
    maxBrokerStateAgeMs: 120_000,
    maxMarketDataAgeMs: 120_000,
    maxAdverseSlippageBps: 100,
    maxOpenOrders: 2,
    decisionTtlMs: 120_000,
  })

const fixture = (
  premiums: Readonly<Record<string, number>> = {},
  simulation = false,
  account = accountId,
  heldSymbol?: string,
  bindEntryQuote = false,
): ObserveShadowDecisionInput => {
  const simulatedFixture = (
    raw: ReturnType<typeof makeIntradayMomentumTestSnapshot>,
    request: IntradaySnapshotRequest,
  ) => {
    const { cut, query } = streamingFixtureFromRaw(raw, request)
    const runId = hash('b')
    const source = {
      runId,
      sourceManifestHash: hash('c'),
      featureTopic: protocol.streamingInput.featureTopic,
      deliveryModel: {
        schemaVersion: 'bayn.supplied-arrival-times.v1',
        description: 'Deterministic fixture arrivals',
        tieBreak: 'availability-topic-partition-offset',
      },
    } as const
    return value(
      constructSimulatedSnapshot(
        {
          runId,
          source,
          universe: {
            universeId: protocol.universeId,
            universeSymbolHash: protocol.universeSymbolHash,
            symbols: protocol.universe,
            topics: { ...protocol.sourceTopics, features: protocol.streamingInput.featureTopic },
          },
          projection: { ...cut.projection, epoch: `historical-${runId}`, availabilityMode: 'simulated' },
          processedRecords: cut.projection.sequence,
          suppliedOffsets: cut.projection.offsets,
          lastArrival: null,
        },
        source,
        query,
      ),
    )
  }
  const cycle = activeCycle(account)
  const rawSnapshot = makeIntradayMomentumTestSnapshot(protocol, snapshotRequest(), premiums)
  const snapshot = simulation
    ? simulatedFixture(rawSnapshot, snapshotRequest())
    : streamingFixtureFromRaw(rawSnapshot, snapshotRequest()).snapshot
  const decisionMarketData = value(executionMarketDataBinding(snapshot))
  const compiledDecision = value(
    decideIntradayMomentum(
      {
        snapshot,
        session: {
          sessionDate,
          openAt: cycle.window.executionOpenAt,
          closeAt: cycle.window.executionCloseAt,
          calendarHash: cycle.window.executionCalendarHash,
        },
      },
      protocol,
    ),
  )
  const executionPolicy = policy(account)
  const broker = brokerState(account, heldSymbol)
  const planningTargetWeights = intradayMomentumPlanningTargetWeights(
    compiledDecision,
    broker.positions.filter(({ quantityMicros }) => BigInt(quantityMicros) !== 0n).map(({ symbol }) => symbol),
  )
  const planningSymbols = Object.keys(planningTargetWeights)
  const hasEntryTargets = compiledDecision.selectedSymbols.length > 0
  const pricingRequest = {
    ...snapshotRequest(),
    symbols: planningSymbols,
    purpose: IntradaySnapshotPurpose.EntryPricing,
  }
  const rawPricing = makeIntradayMomentumTestSnapshot(protocol, pricingRequest, premiums)
  const pricing = !hasEntryTargets
    ? snapshot
    : simulation
      ? simulatedFixture(rawPricing, pricingRequest)
      : streamingFixtureFromRaw(rawPricing, pricingRequest).snapshot
  const pricingMarketData = hasEntryTargets ? value(executionMarketDataBinding(pricing)) : decisionMarketData
  const marketData = pricingMarketData
  const priceMicros = Object.fromEntries(
    planningSymbols.map((symbol) => [
      symbol,
      String(Math.round((pricing.latestQuotes[symbol]?.askPrice ?? 0) * 1000000)),
    ]),
  )
  const bidPriceMicros = Object.fromEntries(
    planningSymbols.map((symbol) => [
      symbol,
      String(Math.round((pricing.latestQuotes[symbol]?.bidPrice ?? 0) * 1000000)),
    ]),
  )
  const askPriceMicros = Object.fromEntries(
    planningSymbols.map((symbol) => [
      symbol,
      String(Math.round((pricing.latestQuotes[symbol]?.askPrice ?? 0) * 1000000)),
    ]),
  )
  const priceMaterial = {
    schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
    signalDate: sessionDate,
    observedAt,
    snapshotId: marketData.snapshotId,
    snapshotContentHash: marketData.contentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    priceMicros,
    bidPriceMicros,
    askPriceMicros,
  }
  const plannerInput: QuoteBoundTargetPlannerInput = {
    schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
    strategyName: 'intraday-momentum',
    cycleId: cycle.identity.cycleId,
    decisionHash: canonicalHashV1(compiledDecision),
    policyHash: canonicalHashV1(executionPolicy),
    accountId: account,
    signalDate: sessionDate,
    targetWeights: planningTargetWeights,
    referencePrices: { ...priceMaterial, contentHash: canonicalHashV1(priceMaterial) },
    brokerState: {
      account: broker.account,
      positions: broker.positions,
      positionsObservedAt: brokerObservedAt,
      orders: broker.orders,
      ordersObservedAt: brokerObservedAt,
      accountingHash,
      reconciliation: broker.reconciliation,
      unknownOrderCount: 0,
    },
    precision: {
      ...intradayMomentumExecutionModel.precision,
      quantityIncrementMicros: '1000000',
    },
    allocationCapitalMicros: '2000000000',
    executionTerms: {
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      priceReference: 'verified-adverse-quote-boundary',
      snapshotId: marketData.snapshotId,
      snapshotContentHash: marketData.contentHash,
      maximumBuyQuantityMicros: Object.fromEntries(planningSymbols.map((symbol) => [symbol, '1000000'])),
      maximumSellQuantityMicros: Object.fromEntries(planningSymbols.map((symbol) => [symbol, '1000000'])),
    },
    maximumInputAgeMs: 120_000,
    submissionCutoffAt: cycle.window.submissionCutoffAt,
    observedAt,
  }
  const targetPlan = value(planTargets(plannerInput))
  const boundExecutionSession = value(
    bindCycleExecutionSession({
      cycle,
      executionSessionDate: sessionDate,
      planningBrokerState: { observedAt: brokerObservedAt, contentHash: broker.stateHash },
      calendar,
      executionModel: intradayMomentumExecutionModel,
    }),
  )
  const riskInputs: ShadowDeltaRiskInput[] = targetPlan.intentTargets.map((target) => {
    const plannedTarget = targetPlan.targets.find(({ symbol }) => symbol === target.symbol)
    if (plannedTarget === undefined) throw new Error(`intraday fixture is missing ${target.symbol}`)
    return {
      symbol: target.symbol,
      notionalLimitMicros: (
        (BigInt(target.quantityMicros) * BigInt(plannedTarget.referencePriceMicros)) /
        1_000_000n
      ).toString(),
      state: Effect.runSync(
        decodeState({
          schemaVersion: 'bayn.paper-risk-state.v2',
          brokerMode: BrokerMode.Execution,
          account: broker.account,
          positions: broker.positions,
          positionsObservedAt: brokerObservedAt,
          orders: broker.orders,
          ordersObservedAt: brokerObservedAt,
          reconciliation: broker.reconciliation,
          authority: {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash: hash('6'),
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
            version: 1,
            updatedAt: brokerObservedAt,
          },
          authorityObservedAt: brokerObservedAt,
          unknownMutationCount: 0,
          dailyTradedNotionalMicros: '0',
          dayStartEquityMicros: broker.account.equityMicros,
          peakEquityMicros: broker.account.equityMicros,
          accountingHash,
          marketDataSymbol: target.symbol,
          marketDataHash: marketData.contentHash,
          executionMarketDataHash: marketData.contentHash,
          referencePriceMicros: plannedTarget.referencePriceMicros,
          expectedExecutionPriceMicros: plannedTarget.referencePriceMicros,
          marketDataObservedAt: marketData.observedAt,
          ...(bindEntryQuote && target.side === Side.Buy
            ? {
                entryQuote: {
                  eventAt: pricing.latestQuotes[target.symbol]?.eventAt,
                  maximumAgeMs: pricing.manifest.maximumQuoteAgeMs,
                },
              }
            : {}),
          executionSession: boundExecutionSession,
          reservedBuyingPowerMicros: '0',
          evaluatedAt: plannerInput.observedAt,
        }),
      ),
    }
  })
  return {
    cycle,
    snapshot: {
      snapshotId: decisionMarketData.snapshotId,
      contentHash: decisionMarketData.contentHash,
      finalizedAt: decisionMarketData.observedAt,
    },
    compiledDecision,
    decisionMarketDataRows: value(persistIntradayRecordRows(snapshot)),
    ...(hasEntryTargets ? { executionMarketDataRows: value(persistIntradayRecordRows(pricing)) } : {}),
    ...(hasEntryTargets ? { decisionMarketData } : {}),
    executionMarketData: marketData,
    plannerInput,
    targetPlan,
    policy: executionPolicy,
    riskInputs,
  }
}

const executionSession = (input: ObserveShadowDecisionInput) => {
  return value(
    bindCycleExecutionSession({
      cycle: input.cycle,
      executionSessionDate: sessionDate,
      planningBrokerState: {
        observedAt: brokerObservedAt,
        contentHash: input.plannerInput.brokerState.reconciliation.observedHash,
      },
      calendar,
      executionModel: intradayMomentumExecutionModel,
    }),
  )
}

const fixtureRiskContext = (
  input: ObserveShadowDecisionInput,
  riskInputs = input.riskInputs,
): ExecutionDecisionInput['riskContext'] => {
  const state = riskInputs[0]?.state
  return {
    authority: state?.authority ?? {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: hash('6'),
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
      version: 1,
      updatedAt: brokerObservedAt,
    },
    authorityObservedAt: state?.authorityObservedAt ?? brokerObservedAt,
    unknownMutationCount: state?.unknownMutationCount ?? 0,
    dailyTradedNotionalMicros: state?.dailyTradedNotionalMicros ?? '0',
    dayStartEquityMicros: state?.dayStartEquityMicros ?? input.plannerInput.brokerState.account.equityMicros,
    peakEquityMicros: state?.peakEquityMicros ?? input.plannerInput.brokerState.account.equityMicros,
  }
}

describe('intraday shadow decision', () => {
  test('decision rereads reuse only exact fresh JSON and retain current database evidence', async () => {
    const original = await Effect.runPromise(buildObserveShadowDecision(fixture()))
    const alternate = await Effect.runPromise(buildObserveShadowDecision(fixture({}, false, 'another-account')))
    const persisted = structuredClone(original)
    let stored: unknown = persisted
    let completion = false
    let superseded = false
    let missing = false
    let queries = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const released = yield* Deferred.make<void>()
          let pauseNext = false
          const client = yield* SqlClient.make({
            acquirer: Effect.die('Decision query contract tests never connect to PostgreSQL'),
            compiler: PgClient.makeCompiler(undefined, false),
            spanAttributes: [],
          })
          const sql = new Proxy(client, {
            get(target, property, receiver) {
              if (property === 'json') return (value: unknown) => JSON.stringify(value)
              return Reflect.get(target, property, receiver)
            },
            apply(target, receiver, args) {
              const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, args)
              const [query, parameters] = statement.compile()
              if (query === 'clock_timestamp()') return statement
              expect(query).toContain('document = $1::jsonb')
              expect(query).toContain('paper_cycle_completion_evidence_matches')
              expect(query).toContain('paper_cycle_generation_is_superseded')
              const supplied: unknown = typeof parameters[0] === 'string' ? JSON.parse(parameters[0]) : parameters[0]
              const matches = canonicalHashV1(supplied) === canonicalHashV1(stored)
              queries += 1
              const result = Effect.succeed(
                missing
                  ? []
                  : [
                      {
                        // A matching SQL witness alone selects the retained body;
                        // mismatch must decode the complete newly read document.
                        document: matches ? null : stored,
                        matches_retained_document: matches,
                        execution_completion_evidence_matches: completion,
                        execution_generation_is_superseded: superseded,
                      },
                    ],
              )
              if (!pauseNext) return result
              pauseNext = false
              return Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(released)),
                Effect.andThen(result),
              )
            },
          }) as PgClient.PgClient
          const store = makeCycleQueries(sql)
          const read = () => store.selectDecisionDocuments(original.bindings.cycleId)
          expect(yield* read()).toEqual([original])
          yield* store.retainValidatedDecision(original)
          Object.defineProperty(original.bindings, 'accountId', { value: 'caller-poison' })
          const first = (yield* read())[0]
          expect(first).toEqual(persisted)
          if (first === undefined) throw new Error('Expected retained document')
          expect(cycleDecisionStoreEvidence(first)).toEqual({
            executionCompletionEvidenceMatches: false,
            executionGenerationIsSuperseded: false,
          })
          Object.defineProperty(first.bindings, 'accountId', { value: 'return-poison' })
          completion = true
          superseded = true
          const second = (yield* read())[0]
          expect(second).toEqual(persisted)
          if (second === undefined) throw new Error('Expected reread document')
          expect(cycleDecisionStoreEvidence(second)).toEqual({
            executionCompletionEvidenceMatches: true,
            executionGenerationIsSuperseded: true,
          })
          stored = { ...persisted, bindings: { ...persisted.bindings, accountId: 'corrupt-same-hash' } }
          expect(Result.isFailure(yield* Effect.result(read()))).toBe(true)
          stored = alternate
          expect(yield* read()).toEqual([alternate])
          // A seed (including one from a subsequently failed bind) cannot create a row.
          yield* store.retainValidatedDecision(alternate)
          missing = true
          expect(yield* read()).toEqual([])
          expect(queries).toBe(6)
          missing = false
          stored = persisted
          yield* store.retainValidatedDecision(persisted)
          pauseNext = true
          const pending = yield* Effect.forkChild(read())
          yield* Deferred.await(started)
          yield* store.retainValidatedDecision(alternate)
          stored = alternate
          expect(yield* read()).toEqual([alternate])
          yield* Deferred.succeed(released, undefined)
          expect(yield* Fiber.join(pending)).toEqual([persisted])
          expect(queries).toBe(8)
          const exotic = structuredClone(persisted)
          const alteredJson = new Proxy(exotic.bindings, {
            get(target, key, receiver) {
              if (key === 'toJSON') return () => ({ ...target, accountId: 'serialized-poison' })
              return Reflect.get(target, key, receiver)
            },
          })
          Object.defineProperty(exotic, 'bindings', { value: alteredJson })
          yield* store.retainValidatedDecision(exotic)
          stored = JSON.parse(JSON.stringify(exotic))
          expect(Result.isFailure(yield* Effect.result(read()))).toBe(true)
        }),
      ).pipe(Effect.provide(Reactivity.layer)),
    )
  })

  const postgresTest = baynTestPostgresUrl === undefined ? test.skip : test
  postgresTest('migrated cycle guard validates constructed no-trade plans against durable risk facts', async () => {
    if (baynTestPostgresUrl === undefined) throw new Error('missing local PostgreSQL test URL')
    const url = new URL(baynTestPostgresUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
      throw new Error('risk-context regression requires a disposable local test database')
    }
    const input = fixture()
    const riskContext = {
      ...fixtureRiskContext(input),
      authority: { ...fixtureRiskContext(input).authority, version: 2 },
    }
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        riskContext,
        executionSession: executionSession(input),
      }),
    )
    expect(input.riskInputs).toEqual([])
    expect(document.targetPlan.status).toBe(TargetPlanStatus.NoTrade)
    expect(document.deltaRisk).toEqual([])
    expect(document.bindings.riskContext).toEqual(riskContext)
    expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
    const runtime = ManagedRuntime.make(
      PostgresClientLive({
        operationTimeoutMs: 30_000,
        postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    )
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* postgresMigrations
          const reconciliation = input.plannerInput.brokerState.reconciliation
          yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id,
          expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${reconciliation.reconciliationId}, ${reconciliation.schemaVersion}, ${accountId},
          ${reconciliation.expectedHash}, ${reconciliation.observedHash}, ${reconciliation.contentHash},
          ${reconciliation.status}, '[]'::jsonb, ${reconciliation.reconciledAt})`
          const initialAt = new Date(Date.parse(brokerObservedAt) - 1000).toISOString()
          yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${hash('1')}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${initialAt})`
          yield* sql`INSERT INTO authority_generations (
          generation_hash, schema_version, activation_schema_version, previous_generation_hash,
          maximum, authority_version, activation_source_revision, activation_image_repository,
          activation_image_digest, strategy_name, strategy_behavior_hash, strategy_parameter_hash,
          strategy_parameter_schema_version, strategy_protocol_hash, account_id,
          broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
          risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash,
          research_plan_hash, activated_at
        ) VALUES (${hash('6')}, 'bayn.authority-generation-history.v1', 'bayn.paper-authority-generation.v3',
          ${hash('1')}, ${Authority.Execution}, 2, ${'3'.repeat(40)}, 'registry.example.test/lab/bayn',
          ${`sha256:${hash('4')}`}, 'intraday-momentum', ${hash('5')}, ${hash('7')},
          'bayn.intraday-momentum.protocol.v2', ${input.cycle.identity.strategyProtocolHash}, ${accountId},
          'bayn.broker-identity.v2', ${hash('8')}, 'alpaca', 'sandbox', ${document.bindings.policyHash},
          ${hash('9')}, ${reconciliation.reconciliationId}, ${reconciliation.contentHash}, ${hash('b')}, ${brokerObservedAt})`
          yield* sql`INSERT INTO authority_state (schema_version, generation_hash, maximum, effective, kill_state, version, updated_at)
          VALUES ('bayn.paper-authority.v1', ${hash('1')}, ${Authority.Observe}, ${Authority.Observe}, ${KillState.Clear}, 1, ${initialAt})`
          yield* sql`UPDATE authority_state SET generation_hash = ${hash('6')}, maximum = ${Authority.Execution},
          effective = ${Authority.Execution}, version = 2, updated_at = ${brokerObservedAt} WHERE singleton`
          yield* sql`INSERT INTO valuations (valuation_id, schema_version, account_id, source_hash,
          cash_micros, long_market_value_micros, short_market_value_micros, equity_micros, as_of)
          VALUES (${hash('a')}, 'bayn.paper-valuation.v1', ${accountId}, ${hash('b')},
          ${riskContext.dayStartEquityMicros}, 0, 0, ${riskContext.dayStartEquityMicros}, ${reconciliation.reconciledAt})`
          const marketData = document.bindings.executionMarketData
          if (marketData?.schemaVersion !== 'bayn.execution-market-data-binding.v3')
            throw new Error('missing streaming fixture binding')
          yield* sql`INSERT INTO streaming_snapshot_references (snapshot_id, schema_version, content_hash, observed_at, manifest)
          VALUES (${marketData.snapshotId}, 'bayn.streaming-snapshot-reference.v1', ${marketData.contentHash},
          ${marketData.observedAt}, ${sql.json({
            schemaVersion: 'bayn.streaming-market-snapshot.v1',
            streaming: { schemaVersion: 'bayn.streaming-input-cut.v1' },
            snapshotId: marketData.snapshotId,
            contentHash: marketData.contentHash,
            observedAt: marketData.observedAt,
          })})`
          const queries = makeCycleQueries(sql)
          expect(yield* queries.decisionEvidenceMismatch(document)).toBeNull()
          const { contentHash: _contentHash, ...material } = document
          const { riskContext: _riskContext, ...historicalBindings } = material.bindings
          const historical = value(makeExecutionDecisionDocument({ ...material, bindings: historicalBindings }))
          expect(Result.isSuccess(decodeExecutionDecisionDocument(historical))).toBe(true)
          expect(yield* queries.decisionEvidenceMismatch(historical)).toBe(DecisionEvidenceMismatch.RiskContext)
          for (const forgedContext of [
            { ...riskContext, authority: { ...riskContext.authority, version: 3 } },
            { ...riskContext, dayStartEquityMicros: (BigInt(riskContext.dayStartEquityMicros) + 1n).toString() },
            { ...riskContext, peakEquityMicros: (BigInt(riskContext.peakEquityMicros) + 1n).toString() },
            { ...riskContext, dailyTradedNotionalMicros: '1' },
            { ...riskContext, unknownMutationCount: 1 },
          ]) {
            const forged = value(
              makeExecutionDecisionDocument({
                ...material,
                bindings: { ...material.bindings, riskContext: forgedContext },
              }),
            )
            expect(Result.isSuccess(decodeExecutionDecisionDocument(forged))).toBe(true)
            expect(yield* queries.decisionEvidenceMismatch(forged)).toBe(DecisionEvidenceMismatch.RiskContext)
          }
        }),
      )
    } finally {
      await runtime.dispose()
    }
  })
  postgresTest(
    'migrated cycle guard rejects a later expired bound target before its held SELL predecessor fills',
    async () => {
      if (baynTestPostgresUrl === undefined) throw new Error('missing local PostgreSQL test URL')
      const url = new URL(baynTestPostgresUrl)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
        throw new Error('expiry regression requires a disposable local test database')
      }
      const input = fixture({ AAPL: 0.02 }, false, accountId, 'NVDA', true)
      const document = await Effect.runPromise(
        buildExecutionDecision({
          ...input,
          authorityGenerationHash: hash('6'),
          riskContext: fixtureRiskContext(input),
          executionSession: executionSession(input),
        }),
      )
      expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
      expect(document.riskBlock).toBeUndefined()
      const sell = document.deltaRisk[0]
      const buy = document.deltaRisk[1]
      if (sell === undefined || buy === undefined) throw new Error('missing valid mixed target risk')
      expect(sell.evaluation.decision.expiresAt > buy.evaluation.decision.expiresAt).toBe(true)
      const runtime = ManagedRuntime.make(
        CycleStoreLive.pipe(
          Layer.provideMerge(
            PostgresClientLive({
              // Schema setup has its own budget; expiry is checked against the explicit decision timestamps below.
              operationTimeoutMs: 30_000,
              postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      )
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const cycles = yield* CycleStore
            yield* sql`DROP SCHEMA public CASCADE`
            yield* sql`CREATE SCHEMA public`
            yield* postgresMigrations
            yield* cycles.acquire(
              value(makeCycleDraft(input.cycle.identity, input.cycle.window)),
              input.cycle.createdAt,
            )
            yield* cycles.activate(input.cycle.identity.cycleId, input.cycle.updatedAt)
            // Seed the decoded immutable document atomically through the real migrated tables and triggers.
            // This isolates terminalization from external market-source and capital-activation setup.
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO autonomous_cycle_shadow_decisions (cycle_id, schema_version, document, created_at)
            VALUES (${input.cycle.identity.cycleId}, ${document.schemaVersion}, ${sql.json(document)}, ${document.createdAt})`
                yield* sql`UPDATE autonomous_cycles SET snapshot_id = ${document.bindings.snapshotId}, decision_hash = ${document.contentHash},
            state_version = state_version + 1, updated_at = ${document.createdAt} WHERE cycle_id = ${input.cycle.identity.cycleId}`
              }),
            )
            const queries = makeCycleQueries(sql)
            const cold = yield* queries.selectDecisionDocuments(input.cycle.identity.cycleId)
            expect(cold).toEqual([document])
            yield* queries.retainValidatedDecision(document)
            const warm = yield* queries.selectDecisionDocuments(input.cycle.identity.cycleId)
            expect(warm).toEqual(cold)
            expect(warm[0]).not.toBe(cold[0])
            expect(yield* queries.selectDecisionDocuments(hash('0'))).toEqual([])
            const blocked = yield* cycles
              .block(input.cycle.identity.cycleId, CycleTerminalReason.Risk, buy.evaluation.decision.expiresAt)
              .pipe(Effect.result)
            expect(Result.isFailure(blocked)).toBe(true)
            const [retained] = yield* sql<{ state: string; decision_hash: string; terminal_reason: string | null }>`
          SELECT state, decision_hash, terminal_reason FROM autonomous_cycles WHERE cycle_id = ${input.cycle.identity.cycleId}`
            expect(retained).toEqual({ state: 'ACTIVE', decision_hash: document.contentHash, terminal_reason: null })
            const [counts] = yield* sql<{ intents: number; mutations: number; orders: number }>`SELECT
          (SELECT count(*)::integer FROM intents) AS intents, (SELECT count(*)::integer FROM mutation_events) AS mutations,
          (SELECT count(*)::integer FROM orders) AS orders`
            expect(counts).toEqual({ intents: 0, mutations: 0, orders: 0 })
          }),
        )
      } finally {
        await runtime.dispose()
      }
    },
  )

  test.each(
    [false, true].flatMap((allowSubmit) =>
      ['complete', 'partial'].flatMap((commitState) =>
        ['buy-expired', 'sell-expired'].flatMap((expiry) =>
          (expiry === 'sell-expired' ? ['owned', 'unrelated', 'flat'] : ['owned']).flatMap((exposure) =>
            (exposure === 'flat'
              ? [
                  'exact',
                  'inexact',
                  'accounting-inexact',
                  'unknown-order',
                  'unknown-mutation',
                  'stale',
                  'stale-equality',
                  'cutoff-during-read',
                  'future',
                ]
              : ['exact']
            ).map((quality) => ({ allowSubmit, commitState, expiry, exposure, quality })),
          ),
        ),
      ),
    ),
  )(
    'preserves only bound held-position closes at $expiry ($commitState, allowed=$allowSubmit, exposure=$exposure, quality=$quality)',
    async ({ allowSubmit, commitState, expiry, exposure, quality }) => {
      const input = fixture({ AAPL: 0.02 }, false, accountId, 'NVDA', true)
      const document = await Effect.runPromise(
        buildExecutionDecision({
          ...input,
          authorityGenerationHash: hash('6'),
          riskContext: fixtureRiskContext(input),
          executionSession: executionSession(input),
        }),
      )
      expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
      expect(document.riskBlock).toBeUndefined()
      expect(document.targetPlan.intentTargets.map(({ side }) => side)).toEqual([Side.Sell, Side.Buy])
      const sellRisk = document.deltaRisk[0]
      const buyRisk = document.deltaRisk[1]
      if (sellRisk === undefined || buyRisk === undefined) throw new Error('missing bound close-entry risk')
      expect(document.deltaRisk.map(({ evaluation }) => evaluation.decision.outcome)).toEqual([
        RiskOutcome.Approved,
        RiskOutcome.Approved,
      ])
      expect(sellRisk.evaluation.decision.expiresAt > buyRisk.evaluation.decision.expiresAt).toBe(true)
      const evaluatedAt = (expiry === 'buy-expired' ? buyRisk : sellRisk).evaluation.decision.expiresAt
      const factsEvaluatedAt = quality === 'cutoff-during-read' ? document.submissionCutoffAt : evaluatedAt
      const authority = {
        schemaVersion: 'bayn.paper-authority.v1' as const,
        generationHash: hash('6'),
        maximum: Authority.Execution,
        effective: allowSubmit ? Authority.Execution : Authority.Observe,
        kill: allowSubmit ? KillState.Clear : KillState.Active,
        version: 1,
        updatedAt: evaluatedAt,
      }
      const records = new Map<string, StoredIntent>()
      for (const [index, target] of document.targetPlan.intentTargets.entries()) {
        const risk = document.deltaRisk[index]
        if (risk === undefined) throw new Error('missing bound intent risk')
        const intent = await Effect.runPromise(
          planExecutionIntent(
            {
              schemaVersion: legacyIntentPlanSchemaVersion,
              ...target,
              notionalLimitMicros: risk.notionalLimitMicros,
              createdAt: document.createdAt,
            },
            { authority: { ...authority, effective: Authority.Execution, kill: KillState.Clear } },
          ),
        )
        if (commitState === 'partial' && index === 1) continue
        records.set(intent.intentId, {
          intent: { ...intent, state: IntentState.Approved, riskDecisionId: risk.evaluation.decision.decisionId },
          decision: risk.evaluation.decision,
          stateVersion: 2,
          updatedAt: document.createdAt,
        })
      }
      const broker = brokerState(
        accountId,
        exposure === 'owned' ? 'NVDA' : exposure === 'unrelated' ? 'IWM' : undefined,
        quality === 'stale-equality'
          ? new Date(Date.parse(evaluatedAt) - input.policy.maxBrokerStateAgeMs).toISOString()
          : quality === 'stale'
            ? new Date(Date.parse(evaluatedAt) - input.policy.maxBrokerStateAgeMs - 1).toISOString()
            : quality === 'future'
              ? new Date(Date.parse(evaluatedAt) + 1).toISOString()
              : factsEvaluatedAt,
      )
      const currentReconciliation = {
        ...broker.reconciliation,
        status: quality === 'inexact' ? ReconciliationStatus.Discrepancy : ReconciliationStatus.Exact,
      }
      const reconciliation = {
        riskContext: { authority, unknownMutationCount: quality === 'unknown-mutation' ? 1 : 0 },
        brokerState: {
          ...broker,
          reconciliation: currentReconciliation,
          unknownOrderCount: quality === 'unknown-order' ? 1 : 0,
        },
        report: {
          metrics: { accountingExact: quality !== 'accounting-inexact' },
          reconciliation: currentReconciliation,
        },
      } as unknown as ReconciliationPassResult
      const cycle = {
        ...input.cycle,
        bindings: {
          ...input.cycle.bindings,
          snapshotId: document.bindings.snapshotId,
          decisionHash: document.contentHash,
        },
      }
      let commits = 0
      let restrictions = 0
      const step = await Effect.runPromise(
        prepareMutationIntent(
          { accountId, authorityGenerationHash: hash('6'), mutationPhase: 'ENTRY' },
          { executionModel: intradayMomentumExecutionModel },
          input.policy,
          cycle,
          document,
          Effect.succeed(reconciliation),
          allowSubmit,
          false,
          {
            now: Effect.succeed(evaluatedAt),
            readFacts: () =>
              Effect.succeed({
                snapshot: {
                  contentHash: document.bindings.snapshotContentHash,
                  finalizedAt: document.bindings.snapshotFinalizedAt,
                },
                reconciliation,
                authority,
                evaluatedAt: factsEvaluatedAt,
              }),
            restrictAuthority: () =>
              Effect.sync(() => {
                restrictions += 1
              }),
          },
        ).pipe(
          Effect.provideService(IntentStore, {
            read: (id) => Effect.succeed(Option.fromUndefinedOr(records.get(id))),
            commit: () =>
              Effect.sync(() => {
                commits += 1
                throw new Error('expired set must not commit')
              }),
          }),
          Effect.provideService(MutationStore, { latest: () => Effect.void } as unknown as MutationStoreShape),
        ),
      )
      expect(step).toMatchObject(
        exposure !== 'owned' && (quality === 'exact' || quality === 'cutoff-during-read')
          ? {
              _tag: 'Block',
              reason:
                quality === 'cutoff-during-read' ? CycleTerminalReason.MissedSubmission : CycleTerminalReason.Risk,
              observedAt: factsEvaluatedAt,
            }
          : commitState === 'complete' && expiry === 'buy-expired'
            ? allowSubmit
              ? { _tag: 'Execute', action: 'SUBMIT', intentId: document.orderedIntentIds[0] }
              : { _tag: 'Wait', waitReason: 'SUBMISSION_NOT_ALLOWED' }
            : { _tag: 'Wait', waitReason: 'intent-nonterminal' },
      )
      expect(commits).toBe(0)
      expect(restrictions).toBe(0)
      expect(cycle.state).toBe(CycleState.Active)
    },
  )

  test.each([false, true])(
    'accepted lookup recovery precedes a persisted PLANNED sibling with risk=%s',
    async (withRisk) => {
      const input = fixture({ AAPL: 0.02 }, false, accountId, 'NVDA', true)
      const document = await Effect.runPromise(
        buildExecutionDecision({
          ...input,
          authorityGenerationHash: hash('6'),
          riskContext: fixtureRiskContext(input),
          executionSession: executionSession(input),
        }),
      )
      expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
      expect(document.riskBlock).toBeUndefined()
      const records = new Map<string, StoredIntent>()
      const evaluatedAt = document.deltaRisk[1]?.evaluation.decision.expiresAt
      if (evaluatedAt === undefined) throw new Error('missing valid two-target decision')
      const authority = {
        schemaVersion: 'bayn.paper-authority.v1' as const,
        generationHash: hash('6'),
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: document.createdAt,
      }
      for (const [index, target] of document.targetPlan.intentTargets.entries()) {
        const risk = document.deltaRisk[index]?.evaluation.decision
        const notional = document.deltaRisk[index]?.notionalLimitMicros
        if (risk === undefined || notional === undefined) throw new Error('missing bound risk')
        const intent = await Effect.runPromise(
          planExecutionIntent(
            {
              schemaVersion: legacyIntentPlanSchemaVersion,
              ...target,
              notionalLimitMicros: notional,
              createdAt: document.createdAt,
            },
            { authority },
          ),
        )
        records.set(intent.intentId, {
          intent: {
            ...intent,
            state: index === 0 ? IntentState.Acknowledged : IntentState.Planned,
            ...(index === 0 ? { riskDecisionId: risk.decisionId } : {}),
          },
          ...(index === 0 || withRisk ? { decision: risk } : {}),
          stateVersion: 2,
          updatedAt: document.createdAt,
        })
      }
      const firstId = document.orderedIntentIds[0]
      if (firstId === undefined) throw new Error('missing accepted predecessor')
      const event: MutationEvent = {
        schemaVersion: 'bayn.paper-mutation-event.v1',
        eventId: hash('7'),
        mutationId: hash('8'),
        intentId: firstId,
        sequence: 2,
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitAccepted,
        requestHash: hash('9'),
        consistencyDelayMs: 1_000,
        brokerOrderId: 'accepted-owned-close',
        occurredAt: document.createdAt,
      }
      const step = await Effect.runPromise(
        prepareMutationIntent(
          { accountId, authorityGenerationHash: hash('6'), mutationPhase: 'ENTRY' },
          { executionModel: intradayMomentumExecutionModel },
          input.policy,
          {
            ...input.cycle,
            bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
          },
          document,
          Effect.die(new Error('lookup selection must not reconcile')),
          false,
          false,
          {
            now: Effect.succeed(evaluatedAt),
            readFacts: () => Effect.die(new Error('lookup recovery must precede facts')),
            restrictAuthority: () => Effect.die(new Error('lookup selection must not restrict authority')),
          },
        ).pipe(
          Effect.provideService(IntentStore, {
            read: (id) => Effect.succeed(Option.fromUndefinedOr(records.get(id))),
            commit: () => Effect.die(new Error('malformed set cannot commit')),
          }),
          Effect.provideService(MutationStore, {
            latest: (id: string, operation: MutationOperation) =>
              Effect.succeed(id === firstId && operation === MutationOperation.Submit ? event : undefined),
          } as unknown as MutationStoreShape),
        ),
      )
      expect(step).toEqual({ _tag: 'Execute', action: 'RECOVER_SUBMIT', intentId: firstId, observedAt: evaluatedAt })
    },
  )

  test('simulated decision and pricing cuts execute the same planner and risk checks only for their replay account', async () => {
    const build = (input: ObserveShadowDecisionInput) =>
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      })
    const input = fixture({ AAPL: 0.02 }, true, `replay-${hash('b')}`)
    const document = await Effect.runPromise(build(input))
    expect(document.bindings.executionMarketData?.schemaVersion).toBe('bayn.execution-market-data-binding.v4')
    expect(document.targetPlan.intentTargets.length).toBeGreaterThan(0)
    expect(value(reproduceRecordedStreamingDecision(document)).evidenceMode).toBe('recorded-simulated-decision')
    expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
    const rejected = await Effect.runPromise(Effect.result(build(fixture({ AAPL: 0.02 }, true))))
    expect(Result.isFailure(rejected)).toBe(true)
    const pricing = document.bindings.executionMarketData
    if (pricing?.schemaVersion !== 'bayn.execution-market-data-binding.v4') throw new Error('wrong simulation binding')
    const wrongRun = { ...pricing, streaming: { ...pricing.streaming, runId: hash('d') } }
    expect(
      Result.isFailure(
        decodeExecutionDecisionDocument({
          ...document,
          bindings: { ...document.bindings, executionMarketData: wrongRun },
        }),
      ),
    ).toBe(true)
  })

  test('persists reproducible streaming decision and pricing cuts and rejects altered or missing execution rows', async () => {
    const input = fixture({ AAPL: 0.02 })
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      }),
    )
    expect(value(reproduceRecordedStreamingDecision(document)).snapshots).toHaveLength(2)
    expect(document.bindings.executionMarketData?.schemaVersion).toBe('bayn.execution-market-data-binding.v3')
    expect(document.decisionMarketDataRows?.bars.length).toBe(210)
    expect(document.executionMarketDataRows?.quotes.length).toBeGreaterThan(0)
    expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
    const { executionMarketDataRows: _rows, ...missing } = document
    expect(Result.isFailure(decodeExecutionDecisionDocument(missing))).toBe(true)
    expect(
      Result.isFailure(
        decodeExecutionDecisionDocument({ ...document, executionMarketDataRows: { bars: [], quotes: [], trades: [] } }),
      ),
    ).toBe(true)
  })

  test('persists one deterministic no-trade observation against the exact verified snapshot', async () => {
    const input = fixture()

    const first = await Effect.runPromise(buildObserveShadowDecision(input))
    const second = await Effect.runPromise(buildObserveShadowDecision(input))

    expect(input.targetPlan.status).toBe(TargetPlanStatus.NoTrade)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        strategyName: 'intraday-momentum',
        snapshotId: input.snapshot.snapshotId,
        snapshotContentHash: input.snapshot.contentHash,
      },
      deltaRisk: [],
    })
  })

  test.each([Authority.Observe, Authority.Execution])(
    'starts %s decision construction inside its observed Effect and retains identical evidence',
    async (authority) => {
      const input = fixture()
      const cycle = input.cycle
      let cycleReads = 0
      const executionInput = {
        ...input,
        authorityGenerationHash: hash('6'),
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      }
      const build = (): Effect.Effect<CycleDecisionDocument, ShadowDecisionError> =>
        authority === Authority.Execution ? buildExecutionDecision(executionInput) : buildObserveShadowDecision(input)
      const expected = await Effect.runPromise(build())
      Object.defineProperty(authority === Authority.Execution ? executionInput : input, 'cycle', {
        enumerable: true,
        get: () => {
          cycleReads += 1
          return cycle
        },
      })
      const program = build()
      expect(cycleReads).toBe(0)
      const timings = new Map<string, ExecutionStageTiming>()
      const active = new Map<symbol, ActiveExecutionStage>()
      const actual = await Effect.runPromise(
        program.pipe(
          Effect.provideService(ExecutionStageTimings, timings),
          Effect.provideService(ActiveExecutionStages, active),
        ),
      )
      expect(cycleReads).toBeGreaterThan(0)
      expect(actual).toEqual(expected)
      expect([...timings.values()]).toMatchObject([
        {
          stage: 'bayn.execution.decision-build',
          operation: authority,
          count: 1,
          failures: 0,
          interruptions: 0,
        },
      ])
      expect(active.size).toBe(0)
    },
  )

  test('retains a decision validation failure in its construction stage', async () => {
    const input = fixture()
    const timings = new Map<string, ExecutionStageTiming>()
    const active = new Map<symbol, ActiveExecutionStage>()
    const exit = await Effect.runPromiseExit(
      buildObserveShadowDecision({ ...input, snapshot: { ...input.snapshot, contentHash: hash('0') } }).pipe(
        Effect.provideService(ExecutionStageTimings, timings),
        Effect.provideService(ActiveExecutionStages, active),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect([...timings.values()]).toMatchObject([
      { stage: 'bayn.execution.decision-build', operation: Authority.Observe, count: 1, failures: 1 },
    ])
    expect(active.size).toBe(0)
  })

  test('retains an execution construction defect inside its observed Effect', async () => {
    const input = fixture()
    const executionInput = {
      ...input,
      authorityGenerationHash: hash('6'),
      riskContext: fixtureRiskContext(input),
      executionSession: executionSession(input),
    }
    const defect = new Error('test construction defect')
    Object.defineProperty(executionInput, 'cycle', {
      enumerable: true,
      get: () => {
        throw defect
      },
    })
    const timings = new Map<string, ExecutionStageTiming>()
    const active = new Map<symbol, ActiveExecutionStage>()
    const program = buildExecutionDecision(executionInput)
    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provideService(ExecutionStageTimings, timings),
        Effect.provideService(ActiveExecutionStages, active),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
    expect([...timings.values()]).toMatchObject([
      { stage: 'bayn.execution.decision-build', operation: Authority.Execution, count: 1, failures: 1 },
    ])
    expect(active.size).toBe(0)
  })

  test('assembles the same no-trade material under execution authority without broker intents', async () => {
    const input = fixture()
    const riskContext = fixtureRiskContext(input)

    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        riskContext,
        executionSession: executionSession(input),
      }),
    )

    expect(document).toMatchObject({
      mode: 'PAPER',
      dispatchable: true,
      orderedIntentIds: [],
      deltaRisk: [],
    })
    expect(document.strategyDecision).toEqual(input.compiledDecision)
    expect(document.bindings.riskContext).toEqual(riskContext)
    expect(Result.isSuccess(decodeExecutionDecisionDocument(document))).toBe(true)
  })

  test('rejects retired intraday-v1 and v2 contracts at every execution boundary', async () => {
    const input = fixture()
    const current = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      }),
    )
    if (current.strategyDecision?.schemaVersion !== 'bayn.intraday-momentum.target.v3') {
      throw new Error('legacy decoder fixture requires one current intraday decision')
    }
    if (current.plannerInput === undefined) throw new Error('legacy decoder fixture requires planner evidence')

    const legacyDecision = {
      schemaVersion: 'bayn.intraday-momentum.target.v1' as const,
      strategy: 'intraday-momentum' as const,
      sessionDate: current.strategyDecision.sessionDate,
      snapshotId: current.strategyDecision.snapshotId,
      observedAt: current.strategyDecision.observedAt,
      calendarHash: current.strategyDecision.calendarHash,
      selectedSymbols: [],
      targetWeights: current.strategyDecision.targetWeights,
      signals: current.strategyDecision.signals.map((signal) => ({
        symbol: signal.symbol,
        referencePriceMicros: signal.referencePriceMicros,
        rangeHighPriceMicros: signal.rangeHighPriceMicros,
        rangeLowPriceMicros: signal.rangeLowPriceMicros,
        bidPriceMicros: signal.bidPriceMicros,
        bidSizeMicros: signal.bidSizeMicros,
        askPriceMicros: signal.askPriceMicros,
        askSizeMicros: signal.askSizeMicros,
        quoteObservedAt: signal.quoteObservedAt,
        confirmationTradePriceMicros: signal.confirmationTradePriceMicros,
        confirmationTradeObservedAt: signal.confirmationTradeObservedAt,
        lookbackReturnBps: signal.lookbackReturnBps,
        breakoutBps: signal.breakoutBps,
        rangeLocationPpm: signal.rangeLocationPpm,
        spreadBps: signal.spreadBps,
        eligible: false,
        rejectionReasons: ['lookback-return' as const],
        rank: null,
      })),
    }
    const strategyDecisionHash = canonicalHashV1(legacyDecision)
    const plannerInput = { ...current.plannerInput, decisionHash: strategyDecisionHash }
    const targetPlan = value(planTargets(plannerInput))
    const { contentHash: _contentHash, ...currentMaterial } = current
    const legacyMaterial = {
      ...currentMaterial,
      bindings: { ...currentMaterial.bindings, strategyDecisionHash },
      strategyDecision: legacyDecision,
      plannerInput,
      targetPlan,
    }
    const persisted = { ...legacyMaterial, contentHash: canonicalHashV1(legacyMaterial) }

    expect(Result.isFailure(decodeExecutionDecisionDocument(persisted))).toBeTrue()
    expect(Result.isFailure(makeExecutionDecisionDocument(legacyMaterial))).toBeTrue()

    const { excludedCandidates: _exclusions, ...currentDecision } = current.strategyDecision
    const legacyV2Decision = { ...currentDecision, schemaVersion: 'bayn.intraday-momentum.target.v2' as const }
    const legacyV2DecisionHash = canonicalHashV1(legacyV2Decision)
    const legacyV2Planner = { ...current.plannerInput, decisionHash: legacyV2DecisionHash }
    const legacyV2Material = {
      ...currentMaterial,
      bindings: { ...currentMaterial.bindings, strategyDecisionHash: legacyV2DecisionHash },
      strategyDecision: legacyV2Decision,
      plannerInput: legacyV2Planner,
      targetPlan: value(planTargets(legacyV2Planner)),
    }
    expect(
      Result.isFailure(
        decodeExecutionDecisionDocument({
          ...legacyV2Material,
          contentHash: canonicalHashV1(legacyV2Material),
        }),
      ),
    ).toBeTrue()
    expect(Result.isFailure(makeExecutionDecisionDocument(legacyV2Material))).toBeTrue()
  })

  test('binds durable execution material to the exact snapshot and complete target universe', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    if (input.compiledDecision.schemaVersion !== 'bayn.intraday-momentum.target.v3') {
      throw new Error('intraday fixture requires one entry decision')
    }
    expect(input.compiledDecision.selectedSymbols).toEqual([selectedSymbol])
    expect(input.targetPlan.status).toBe(TargetPlanStatus.Planned)
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    expect(material.strategyDecision).toEqual(input.compiledDecision)
    expect(material.plannerInput).toEqual(input.plannerInput)
    const { plannerInput: _plannerInput, ...withoutPlannerInput } = material
    const missingPlannerInput = makeExecutionDecisionDocument(withoutPlannerInput)
    expect(Result.isFailure(missingPlannerInput)).toBe(true)
    if (Result.isFailure(missingPlannerInput)) {
      expect(String(missingPlannerInput.failure.cause)).toContain('requires persisted target-planner evidence')
    }
    const forgedMetricDecision = {
      ...input.compiledDecision,
      signals: input.compiledDecision.signals.map((signal, index) =>
        index === 0 ? { ...signal, lookbackReturnBps: signal.lookbackReturnBps + 1 } : signal,
      ),
    }
    const forgedMetricDocument = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        strategyDecisionHash: canonicalHashV1(forgedMetricDecision),
      },
      strategyDecision: forgedMetricDecision,
    })
    expect(Result.isFailure(forgedMetricDocument)).toBeTrue()
    if (Result.isFailure(forgedMetricDocument)) {
      expect(String(forgedMetricDocument.failure.cause)).toContain('signal metrics must match persisted price evidence')
    }
    const originalSignal = input.compiledDecision.signals[0]
    if (originalSignal === undefined) throw new Error('intraday fixture requires signal evidence')
    const forgedSignalReferencePrice = BigInt(originalSignal.referencePriceMicros) + 1n
    const forgedPriceMetrics = value(
      deriveIntradayMomentumSignalMetrics(
        {
          reference: forgedSignalReferencePrice,
          high: BigInt(originalSignal.rangeHighPriceMicros),
          low: BigInt(originalSignal.rangeLowPriceMicros),
          bid: BigInt(originalSignal.bidPriceMicros),
          ask: BigInt(originalSignal.askPriceMicros),
          trade: BigInt(originalSignal.confirmationTradePriceMicros),
        },
        originalSignal.symbol,
        {
          reference: BigInt(input.compiledDecision.benchmark.referencePriceMicros),
          bid: BigInt(input.compiledDecision.benchmark.bidPriceMicros),
          ask: BigInt(input.compiledDecision.benchmark.askPriceMicros),
        },
      ),
    )
    const forgedPriceDecision = {
      ...input.compiledDecision,
      signals: input.compiledDecision.signals.map((signal, index) =>
        index === 0
          ? {
              ...signal,
              referencePriceMicros: String(forgedSignalReferencePrice),
              ...forgedPriceMetrics.metrics,
              excessReturnNumerator: String(forgedPriceMetrics.excessReturn.numerator),
              excessReturnDenominator: String(forgedPriceMetrics.excessReturn.denominator),
            }
          : signal,
      ),
    }
    const forgedPriceDocument = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        strategyDecisionHash: canonicalHashV1(forgedPriceDecision),
      },
      strategyDecision: forgedPriceDecision,
    })
    expect(Result.isFailure(forgedPriceDocument)).toBe(true)
    if (Result.isFailure(forgedPriceDocument)) {
      expect(String(forgedPriceDocument.failure.cause)).toContain(
        'strategy decision must be reproduced from its exact verified archive rows',
      )
    }
    const forgedSelectedSymbol = protocol.candidateSymbols.find((symbol) => symbol !== selectedSymbol)
    if (forgedSelectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const forgedStrategyDecision = {
      ...input.compiledDecision,
      selectedSymbols: [forgedSelectedSymbol],
      targetWeights: Object.fromEntries(
        protocol.candidateSymbols.map((symbol) => [symbol, symbol === forgedSelectedSymbol ? 0.1 : 0]),
      ),
      signals: input.compiledDecision.signals.map((signal) => {
        if (signal.symbol === forgedSelectedSymbol) {
          return { ...signal, eligible: true, rejectionReasons: [], rank: 1 }
        }
        return signal.symbol === selectedSymbol
          ? { ...signal, eligible: false, rejectionReasons: ['excess-return' as const], rank: null }
          : signal
      }),
    }
    const forgedTargetSelection = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        strategyDecisionHash: canonicalHashV1(forgedStrategyDecision),
      },
      strategyDecision: forgedStrategyDecision,
    })
    expect(Result.isFailure(forgedTargetSelection)).toBe(true)
    if (Result.isFailure(forgedTargetSelection)) {
      expect(String(forgedTargetSelection.failure.cause)).toContain('canonical source-controlled signal ranking')
    }

    const strategyBindingForgeries = [
      { snapshotId: hash('d') },
      { sessionDate: '2026-08-19' as const },
      { observedAt: '2026-08-18T16:00:03.000Z' },
      { calendarHash: hash('e') },
    ]
    for (const overrides of strategyBindingForgeries) {
      const strategyDecision = { ...input.compiledDecision, ...overrides }
      const forged = makeExecutionDecisionDocument({
        ...material,
        bindings: {
          ...material.bindings,
          strategyDecisionHash: canonicalHashV1(strategyDecision),
        },
        strategyDecision,
      })
      expect(Result.isFailure(forged)).toBeTrue()
      if (Result.isFailure(forged)) {
        expect(String(forged.failure.cause)).toContain('exact market-data snapshot and session')
      }
    }

    const omittedSymbol = selectedSymbol
    const { outputHash: _outputHash, ...targetPlanMaterial } = material.targetPlan
    const rehashTargetPlan = (targets: typeof targetPlanMaterial.targets) => {
      const forgedTargetPlanMaterial = { ...targetPlanMaterial, targets }
      return { ...forgedTargetPlanMaterial, outputHash: canonicalHashV1(forgedTargetPlanMaterial) }
    }
    const targetForForgery = targetPlanMaterial.targets.find(({ symbol }) => symbol === selectedSymbol)
    if (targetForForgery === undefined) throw new Error('intraday fixture requires its selected target')
    const quantityShift = 1_000_000n
    const forgedQuantities = makeExecutionDecisionDocument({
      ...material,
      targetPlan: rehashTargetPlan(
        targetPlanMaterial.targets.map((target) =>
          target.symbol === targetForForgery.symbol
            ? {
                ...target,
                currentQuantityMicros: (BigInt(target.currentQuantityMicros) + quantityShift).toString(),
                targetQuantityMicros: (BigInt(target.targetQuantityMicros) + quantityShift).toString(),
              }
            : target,
        ),
      ),
    })
    expect(Result.isFailure(forgedQuantities)).toBe(true)
    if (Result.isFailure(forgedQuantities)) {
      expect(String(forgedQuantities.failure.cause)).toContain('persisted target-planner evidence')
    }

    const forgedReferencePrice = makeExecutionDecisionDocument({
      ...material,
      targetPlan: rehashTargetPlan(
        targetPlanMaterial.targets.map((target) =>
          target.symbol === omittedSymbol
            ? { ...target, referencePriceMicros: (BigInt(target.referencePriceMicros) + 1n).toString() }
            : target,
        ),
      ),
    })
    expect(Result.isFailure(forgedReferencePrice)).toBe(true)
    if (Result.isFailure(forgedReferencePrice)) {
      expect(String(forgedReferencePrice.failure.cause)).toContain('exact aggregate reference notional')
    }

    const reducedTargetPlanMaterial = {
      ...targetPlanMaterial,
      targets: targetPlanMaterial.targets.filter(({ symbol }) => symbol !== omittedSymbol),
    }
    const forged = makeExecutionDecisionDocument({
      ...material,
      targetPlan: {
        ...reducedTargetPlanMaterial,
        outputHash: canonicalHashV1(reducedTargetPlanMaterial),
      },
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must contain at most one delta for each persisted target')
    }
  })

  test('reproduces complete durable risk facts before admitting a rehashed execution approval', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const riskInputs = input.riskInputs.map((riskInput) => ({
      ...riskInput,
      state: {
        ...riskInput.state,
        dayStartEquityMicros: (BigInt(riskInput.state.account.equityMicros) + 200_000_000n).toString(),
        peakEquityMicros: riskInput.state.account.equityMicros,
      },
    }))
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        riskInputs,
        authorityGenerationHash: hash('6'),
        riskContext: fixtureRiskContext(input, riskInputs),
        executionSession: executionSession(input),
      }),
    )

    expect(document.riskPolicy).toEqual(input.policy)
    expect(document.deltaRisk.every(({ facts }) => facts !== undefined)).toBeTrue()
    expect(document.riskBlock?.reasonCodes).toEqual([Reason.DailyLossExceeded])
    expect(document.dispatchable).toBeFalse()

    const forgedDeltaRisk = document.deltaRisk.map((risk) => {
      const { decisionId: _decisionId, ...decisionMaterial } = risk.evaluation.decision
      const approvedDecisionMaterial = {
        ...decisionMaterial,
        outcome: RiskOutcome.Approved,
        reasonCodes: [],
      }
      return {
        ...risk,
        evaluation: {
          ...risk.evaluation,
          gates: risk.evaluation.gates.map((gate) => ({ ...gate, passed: true })),
          decision: {
            ...approvedDecisionMaterial,
            decisionId: canonicalHashV1(approvedDecisionMaterial),
          },
        },
      }
    })
    const { contentHash: _contentHash, riskBlock: _riskBlock, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      dispatchable: true,
      deltaRisk: forgedDeltaRisk,
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must reproduce the exact persisted risk gates')
    }
    expect(
      document.deltaRisk.some(({ evaluation }) => evaluation.gates.some(({ name }) => name === Gate.DailyLoss)),
    ).toBeTrue()
  })

  test('rejects a fully rehashed evaluation whose durable risk context differs from the bound planner state', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const authorityGenerationHash = hash('6')
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash,
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      }),
    )
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk?.facts === undefined) {
      throw new Error('risk-context fixture requires one persisted execution risk input')
    }
    const intent = value(
      makeExecutionIntentFromDecodedPlan(
        {
          schemaVersion: legacyIntentPlanSchemaVersion,
          ...target,
          notionalLimitMicros: risk.notionalLimitMicros,
        },
        authorityGenerationHash,
      ),
    )
    const forgedState = {
      ...risk.facts.state,
      dayStartEquityMicros: (BigInt(risk.facts.state.dayStartEquityMicros) + 1n).toString(),
    }
    const forgedEvaluation = value(
      evaluate({
        intent,
        state: forgedState,
        policy: input.policy,
        proposedPositions: risk.facts.proposedPositions,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      deltaRisk: [{ ...risk, facts: { ...risk.facts, state: forgedState }, evaluation: forgedEvaluation }],
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must match the exact planner, authority, market-data')
    }
  })

  test('rejects a fully rehashed evaluation whose authority version differs from the bound state', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const authorityGenerationHash = hash('6')
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash,
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      }),
    )
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk?.facts === undefined) {
      throw new Error('authority fixture requires one persisted execution risk input')
    }
    const intent = value(
      makeExecutionIntentFromDecodedPlan(
        {
          schemaVersion: legacyIntentPlanSchemaVersion,
          ...target,
          notionalLimitMicros: risk.notionalLimitMicros,
        },
        authorityGenerationHash,
      ),
    )
    const forgedState = {
      ...risk.facts.state,
      authority: { ...risk.facts.state.authority, version: risk.facts.state.authority.version + 1 },
    }
    const forgedEvaluation = value(
      evaluate({
        intent,
        state: forgedState,
        policy: input.policy,
        proposedPositions: risk.facts.proposedPositions,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      deltaRisk: [{ ...risk, facts: { ...risk.facts, state: forgedState }, evaluation: forgedEvaluation }],
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must match the exact planner, authority, market-data')
    }
  })

  test('recomputes quote-bound execution pricing before admitting a rehashed evaluation', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const authorityGenerationHash = hash('6')
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash,
        riskContext: fixtureRiskContext(input),
        executionSession: executionSession(input),
      }),
    )
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk?.facts === undefined) {
      throw new Error('pricing fixture requires one persisted execution risk input')
    }
    const forgedNotionalLimitMicros = (BigInt(risk.notionalLimitMicros) + 1n).toString()
    const intent = value(
      makeExecutionIntentFromDecodedPlan(
        {
          schemaVersion: legacyIntentPlanSchemaVersion,
          ...target,
          notionalLimitMicros: forgedNotionalLimitMicros,
        },
        authorityGenerationHash,
      ),
    )
    const forgedState = {
      ...risk.facts.state,
      expectedExecutionPriceMicros: (BigInt(risk.facts.state.expectedExecutionPriceMicros) + 1n).toString(),
    }
    const forgedEvaluation = value(
      evaluate({
        intent,
        state: forgedState,
        policy: input.policy,
        proposedPositions: risk.facts.proposedPositions,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      orderedIntentIds: [intent.intentId],
      deltaRisk: [
        {
          ...risk,
          notionalLimitMicros: forgedNotionalLimitMicros,
          facts: { ...risk.facts, state: forgedState },
          evaluation: forgedEvaluation,
        },
      ],
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must reproduce the exact persisted risk gates')
    }
  })

  test('fails closed when market data is absent, incomplete, or bound to another calendar', async () => {
    const input = fixture()
    const binding = input.executionMarketData
    if (binding?.schemaVersion !== 'bayn.execution-market-data-binding.v3') {
      throw new Error('intraday fixture requires market-data binding v3')
    }
    const subset = { ...binding, symbols: binding.symbols.slice(0, 1) }
    const variants = [
      { ...input, executionMarketData: undefined },
      { ...input, executionMarketData: subset },
      {
        ...input,
        compiledDecision: { ...input.compiledDecision, calendarHash: hash('f') },
      },
    ]

    for (const variant of variants) {
      const exit = await Effect.runPromiseExit(buildObserveShadowDecision(variant))
      expect(Exit.isFailure(exit)).toBeTrue()
    }
  })

  test('fails closed when the planner result or immutable snapshot binding drifts', async () => {
    const input = fixture()
    const variants = [
      { ...input, snapshot: { ...input.snapshot, snapshotId: hash('f') } },
      { ...input, targetPlan: { ...input.targetPlan, outputHash: hash('e') } },
      { ...input, plannerInput: { ...input.plannerInput, policyHash: hash('d') } },
    ]

    for (const variant of variants) {
      const exit = await Effect.runPromiseExit(buildObserveShadowDecision(variant))
      expect(Exit.isFailure(exit)).toBeTrue()
    }
  })

  test('durable decoding rejects content rewrites and coordinator-only fields', async () => {
    const document = await Effect.runPromise(buildObserveShadowDecision(fixture()))

    expect(
      Result.isFailure(
        decodeObserveShadowDecisionDocument({
          ...document,
          targetPlan: { ...document.targetPlan, outputHash: hash('f') },
        }),
      ),
    ).toBeTrue()
    expect(
      Result.isFailure(
        decodeObserveShadowDecisionDocument({
          ...document,
          coordinatorApproval: true,
        }),
      ),
    ).toBeTrue()
  })
})
