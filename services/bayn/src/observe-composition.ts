import { Clock, Effect } from 'effect'

import type { AutonomousCycleStartup } from './app'
import { BrokerRead, type BrokerReadShape } from './broker/alpaca'
import { makeCycleExecutionPolicyFromModel, type AutonomousCycle } from './cycle'
import { marketCalendarQueryForSignal, startAutonomousCycleLoop, type CyclePassObservation } from './cycle-runner'
import { CycleStore, type CycleStoreShape } from './db/cycle-store'
import type { PaperStoreShape } from './db/paper-store'
import { bindCycleExecutionSession } from './execution-session'
import { makeFillTerms, MICROS } from './execution-model'
import { operationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { MarketData, type MarketDataService } from './market-data'
import { Authority, OrderSide, OrderType, TimeInForce, type AuthorityState } from './paper'
import type { CausalProtocol } from './protocol'
import type { ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, decodePolicy, type Policy, type State } from './risk'
import { buildObserveShadowDecision, type ShadowDeltaRiskInput } from './shadow-decision'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'
import { planTargets, type SignalSessionReferencePrices, type TargetPlannerInput } from './target-planner'
import type { Strategy } from './strategy'

const observeRiskLimits = {
  maxOrderNotionalMicros: '600000000',
  maxSymbolExposureMicros: '600000000',
  maxGrossExposureMicros: '1000000000',
  maxNetExposureMicros: '1000000000',
  maxDailyTradedNotionalMicros: '1000000000',
  maxDailyLossMicros: '100000000',
  maxDrawdownMicros: '100000000',
  maxIntentAgeMs: 300_000,
  maxBrokerStateAgeMs: 300_000,
  maxMarketDataAgeMs: 300_000,
  maxAdverseSlippageBps: 10,
  maxUnresolvedOrders: 0,
  decisionTtlMs: 300_000,
} as const

export const loadObserveRiskPolicy = (accountId: string, allowedSymbols: readonly string[]) =>
  decodePolicy({
    schemaVersion: 'bayn.paper-risk-policy.v1',
    accountId,
    brokerMode: BrokerMode.Paper,
    allowedSymbols: [...allowedSymbols].sort(),
    allowedOrderTypes: [OrderType.Market],
    allowedTimeInForce: [TimeInForce.Day],
    ...observeRiskLimits,
  })

type ObserveStrategy = Pick<Strategy, 'currentDecision'>

export interface ObserveDecisionInput {
  readonly authorityGenerationHash: string
  readonly cycle: AutonomousCycle
  readonly executionModel: CausalProtocol['executionModel']
  readonly marketCalendar: BrokerReadShape['marketCalendar']
  readonly marketData: MarketDataService
  readonly policy: Policy
  readonly reconcile: Effect.Effect<ReconciliationPassResult, unknown>
  readonly strategy: ObserveStrategy
}

const referencePrices = (
  signalDate: SignalSessionReferencePrices['signalDate'],
  observedAt: string,
  priceMicros: Readonly<Record<string, string>>,
): SignalSessionReferencePrices => {
  const material = {
    schemaVersion: 'bayn.signal-session-reference-prices.v1' as const,
    signalDate,
    observedAt,
    priceMicros,
  }
  return { ...material, contentHash: canonicalHashV1(material) }
}

const requireObserveAuthority = (
  result: ReconciliationPassResult,
  policy: Policy,
  authorityGenerationHash: string,
): Effect.Effect<{ readonly authority: AuthorityState; readonly observedAt: string }, Error> => {
  const authority = result.riskContext.authority
  if (
    authority === null ||
    result.riskContext.authorityObservedAt === null ||
    authority.generationHash !== authorityGenerationHash ||
    authority.maximum !== Authority.Observe ||
    authority.effective !== Authority.Observe ||
    result.brokerState.account.accountId !== policy.accountId
  ) {
    return Effect.fail(new Error('same-pass reconciliation did not return the configured OBSERVE authority'))
  }
  return Effect.succeed({ authority, observedAt: result.riskContext.authorityObservedAt })
}

export const buildObserveCycleDecision = (
  input: ObserveDecisionInput,
): Effect.Effect<ObserveShadowDecisionDocument, unknown> =>
  Effect.gen(function* () {
    const snapshotId = input.cycle.bindings.snapshotId
    if (snapshotId === undefined) {
      return yield* Effect.fail(new Error('active autonomous cycle has no immutable snapshot binding'))
    }

    const [snapshot, calendar, reconciliation] = yield* Effect.all(
      [
        input.marketData.loadSnapshotPublication({
          snapshotId,
          signalSessionDate: input.cycle.identity.signalSessionDate,
          signalCalendarVersion: input.cycle.identity.signalCalendarVersion,
        }),
        input.marketCalendar(marketCalendarQueryForSignal(input.cycle.identity.signalSessionDate)),
        input.reconcile,
      ],
      { concurrency: 3 },
    )
    const evaluatedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const authorityObservation = yield* requireObserveAuthority(
      reconciliation,
      input.policy,
      input.authorityGenerationHash,
    )
    const authority = authorityObservation.authority
    const finalizedSnapshot = snapshot.manifest.finalizedSnapshot
    const executionSession = yield* Effect.try({
      try: () =>
        bindCycleExecutionSession({
          cycle: input.cycle,
          signal: {
            sessionDate: input.cycle.identity.signalSessionDate,
            finalizedAt: finalizedSnapshot.finalizedAt,
            contentHash: finalizedSnapshot.contentHash,
          },
          planningBrokerState: {
            observedAt: reconciliation.brokerState.reconciliation.reconciledAt,
            contentHash: reconciledStateHash(reconciliation.brokerState),
          },
          calendar: calendar.value,
          executionModel: input.executionModel,
        }),
      catch: (cause) => new Error('cycle execution-session binding failed', { cause }),
    })
    const compiled = yield* Effect.try({
      try: () => input.strategy.currentDecision(snapshot.bars, snapshot.manifest, executionSession),
      catch: (cause) => new Error('current strategy decision compilation failed', { cause }),
    })
    const prices = referencePrices(compiled.decision.signalDate, evaluatedAt, compiled.priceMicros)
    const policyHash = canonicalHashV1(input.policy)
    const plannerInput: TargetPlannerInput = {
      schemaVersion: 'bayn.paper-target-planner-input.v1',
      strategyName: input.cycle.identity.strategyName,
      cycleId: input.cycle.identity.cycleId,
      decisionHash: canonicalHashV1(compiled.decision),
      policyHash,
      accountId: input.cycle.identity.accountId,
      signalDate: input.cycle.identity.signalSessionDate,
      targetWeights: compiled.decision.targetWeights,
      referencePrices: prices,
      brokerState: reconciliation.brokerState,
      precision: input.executionModel.precision,
      maximumInputAgeMs: Math.min(input.policy.maxBrokerStateAgeMs, input.policy.maxMarketDataAgeMs),
      submissionCutoffAt: input.cycle.window.submissionCutoffAt,
      observedAt: evaluatedAt,
    }
    const targetPlan = yield* Effect.try({
      try: () => planTargets(plannerInput),
      catch: (cause) => new Error('shadow target planning failed', { cause }),
    })
    const riskInputs = yield* Effect.try({
      try: (): readonly ShadowDeltaRiskInput[] =>
        targetPlan.intentTargets.map((target): ShadowDeltaRiskInput => {
          const referencePrice = BigInt(prices.priceMicros[target.symbol])
          const fillTerms = makeFillTerms(
            target.side === OrderSide.Buy ? 'buy' : 'sell',
            BigInt(target.quantityMicros),
            referencePrice,
            input.executionModel,
            MICROS,
          )
          const state: State = {
            schemaVersion: 'bayn.paper-risk-state.v2',
            brokerMode: BrokerMode.Paper,
            account: reconciliation.brokerState.account,
            positions: reconciliation.brokerState.positions,
            positionsObservedAt: reconciliation.brokerState.positionsObservedAt,
            orders: reconciliation.brokerState.orders,
            ordersObservedAt: reconciliation.brokerState.ordersObservedAt,
            reconciliation: reconciliation.brokerState.reconciliation,
            authority,
            authorityObservedAt: authorityObservation.observedAt,
            unknownMutationCount: reconciliation.riskContext.unknownMutationCount,
            dailyTradedNotionalMicros: reconciliation.riskContext.dailyTradedNotionalMicros,
            dayStartEquityMicros: reconciliation.riskContext.dayStartEquityMicros,
            peakEquityMicros: reconciliation.riskContext.peakEquityMicros,
            accountingHash: reconciliation.brokerState.accountingHash,
            marketDataSymbol: target.symbol,
            marketDataHash: finalizedSnapshot.contentHash,
            referencePriceMicros: referencePrice.toString(),
            expectedExecutionPriceMicros: fillTerms.fillPriceMicros.toString(),
            marketDataObservedAt: evaluatedAt,
            executionSession,
            reservedBuyingPowerMicros: '0',
            evaluatedAt,
          }
          return {
            symbol: target.symbol,
            notionalLimitMicros: fillTerms.notionalMicros.toString(),
            state,
          }
        }),
      catch: (cause) => new Error('shadow risk input construction failed', { cause }),
    })
    return yield* buildObserveShadowDecision({
      cycle: input.cycle,
      snapshot: {
        snapshotId: finalizedSnapshot.snapshotId,
        contentHash: finalizedSnapshot.contentHash,
        finalizedAt: finalizedSnapshot.finalizedAt,
      },
      compiledDecision: compiled.decision,
      plannerInput,
      targetPlan,
      policy: input.policy,
      riskInputs,
    })
  })

const observePass = (
  recordPass: Parameters<AutonomousCycleStartup>[0]['recordPass'],
  observation: CyclePassObservation,
) =>
  observation.outcome === 'SUCCEEDED'
    ? recordPass({
        result: 'SUCCESS',
        observedAt: observation.observedAt,
        outcome: observation.result.outcome,
      })
    : recordPass({
        result: 'FAILURE',
        observedAt: observation.observedAt,
        operation: observation.error.operation,
        failure: observation.error.failure,
        message: observation.error.message,
      })

export interface ObserveAutonomousCycleInput {
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly brokerRead: BrokerReadShape
  readonly cycleStore: CycleStoreShape
  readonly marketData: MarketDataService
  readonly maximumAuthority: Authority
  readonly paperStore: PaperStoreShape
  readonly pollIntervalMs: number
  readonly reconcile: Effect.Effect<ReconciliationPassResult, unknown>
  readonly strategy: Pick<Strategy, 'currentDecision' | 'parameters'>
}

export const makeObserveAutonomousCycleStartup = (input: ObserveAutonomousCycleInput): AutonomousCycleStartup => {
  const executionModel = input.strategy.parameters.executionModel
  return (startup) =>
    Effect.gen(function* () {
      if (input.maximumAuthority !== Authority.Observe) {
        return yield* Effect.fail(
          operationalError(
            'config',
            'cycle-loop',
            'PAPER autonomous startup requires the gated Phase B authority generation and dispatch transition',
          ),
        )
      }
      if (executionModel.schemaVersion !== 'bayn.execution-model.v2') {
        return yield* Effect.fail(
          operationalError('strategy', 'cycle-loop', 'autonomous cycles require the causal v2 execution model'),
        )
      }
      const executionPolicy = makeCycleExecutionPolicyFromModel(executionModel)
      const policy = yield* loadObserveRiskPolicy(input.accountId, input.strategy.parameters.universe).pipe(
        Effect.mapError((cause) =>
          operationalError('strategy', 'risk-policy', 'source-controlled paper risk policy is invalid', cause),
        ),
      )
      const authority = yield* input.paperStore
        .ensureAuthorityGeneration({
          generationHash: input.authorityGenerationHash,
          maximum: Authority.Observe,
        })
        .pipe(
          Effect.mapError((cause) =>
            operationalError('database', 'authority', 'OBSERVE authority initialization failed', cause),
          ),
        )
      if (
        authority.generationHash !== input.authorityGenerationHash ||
        authority.maximum !== Authority.Observe ||
        authority.effective !== Authority.Observe
      ) {
        return yield* Effect.fail(
          operationalError('database', 'authority', 'OBSERVE authority initialization returned incompatible state'),
        )
      }
      return yield* startAutonomousCycleLoop({
        context: Effect.succeed({
          qualificationRunId: startup.qualificationRunId,
          strategyProtocolHash: startup.strategyProtocolHash,
          accountId: input.accountId,
          executionPolicy,
          buildDecision: (cycle) =>
            buildObserveCycleDecision({
              authorityGenerationHash: input.authorityGenerationHash,
              cycle,
              executionModel,
              marketCalendar: input.brokerRead.marketCalendar,
              marketData: input.marketData,
              policy,
              reconcile: input.reconcile,
              strategy: input.strategy,
            }),
        }),
        observePass: (observation) => observePass(startup.recordPass, observation),
        pollIntervalMs: input.pollIntervalMs,
      }).pipe(
        Effect.provideService(BrokerRead, input.brokerRead),
        Effect.provideService(CycleStore, input.cycleStore),
        Effect.provideService(MarketData, input.marketData),
        Effect.mapError((cause) =>
          operationalError('strategy', 'cycle-loop', 'autonomous cycle loop failed to start', cause),
        ),
      )
    })
}
