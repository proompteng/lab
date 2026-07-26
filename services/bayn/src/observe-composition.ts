import { Clock, Effect, Result } from 'effect'

import type { AutonomousCycleStartup } from './app'
import { BrokerRead, type BrokerReadShape, type MarketCalendarQuery } from './broker/alpaca'
import { makeCycleExecutionPolicyFromModel, type AutonomousCycle, type CycleExecutionPolicy } from './cycle'
import {
  CycleDecisionBuildError,
  marketCalendarQueryForSignal,
  startAutonomousCycleLoop,
  type CyclePassObservation,
} from './cycle-runner'
import { CycleStore, type CycleStoreShape } from './db/cycle-store'
import { PaperStore, type PaperStoreShape } from './db/paper-store'
import { WriterFence, type WriterFenceService } from './execution/writer-fence'
import {
  bindCycleExecutionSession,
  type ExecutionSessionBinding,
  type ExecutionSessionBindingFailure,
} from './execution-session'
import { makeFillTerms, MICROS } from './execution-model'
import { makeStrategyProtocolHash } from './contracts'
import { operationalError, type OperationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { MarketData, type MarketDataService } from './market-data'
import { Authority, OrderSide, OrderType, TimeInForce, type AuthorityState } from './paper'
import type { CausalProtocol } from './protocol'
import { runOnce, type ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, decodePolicy, type Policy, type State } from './risk'
import { buildObserveShadowDecision, type ShadowDecisionError, type ShadowDeltaRiskInput } from './shadow-decision'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'
import {
  planTargets,
  type SignalSessionReferencePrices,
  type TargetPlannerInput,
  type TargetPlannerFailure,
  type TargetPlanResult,
} from './target-planner'
import type { CurrentStrategyDecision, Strategy } from './strategy'

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

type ReconciliationPassError = Effect.Error<typeof runOnce>

export type ObserveDecisionInput = {
  readonly authorityGenerationHash: string
  readonly cycle: AutonomousCycle
  readonly executionModel: CausalProtocol['executionModel']
  readonly marketCalendar: BrokerReadShape['marketCalendar']
  readonly marketData: MarketDataService
  readonly policy: Policy
  readonly reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError>
  readonly strategy: ObserveStrategy
}

type LoadedSnapshotPublication = Effect.Success<ReturnType<MarketDataService['loadSnapshotPublication']>>
type MarketCalendarRead = Effect.Success<ReturnType<BrokerReadShape['marketCalendar']>>
type CycleCalendarQueryFailure = Result.Result.Failure<ReturnType<typeof marketCalendarQueryForSignal>>

type ObserveDecisionCompositionFailure = {
  readonly _tag: 'ObserveDecisionCompositionFailure'
  readonly operation:
    | 'compiled-decision-hash'
    | 'cycle-binding'
    | 'observe-authority'
    | 'reconciled-state-hash'
    | 'reference-prices'
    | 'risk-policy-hash'
    | 'shadow-risk-inputs'
  readonly message: string
  readonly cause?: unknown
}

export type ObserveDecisionFailure =
  | CycleCalendarQueryFailure
  | ExecutionSessionBindingFailure
  | ObserveDecisionCompositionFailure
  | OperationalError
  | ShadowDecisionError
  | TargetPlannerFailure

type ObserveDecisionReadPreparation = {
  readonly snapshotId: string
  readonly marketCalendarQuery: MarketCalendarQuery
}

type ObserveDecisionFacts = {
  readonly snapshot: LoadedSnapshotPublication
  readonly calendar: MarketCalendarRead
  readonly reconciliation: ReconciliationPassResult
  readonly evaluatedAt: string
}

type ObserveAuthorityObservation = {
  readonly authority: AuthorityState
  readonly observedAt: string
}

type ObservePlannerPreparation = {
  readonly plannerInput: TargetPlannerInput
  readonly prices: SignalSessionReferencePrices
}

const compositionFailure = (
  operation: ObserveDecisionCompositionFailure['operation'],
  message: string,
  cause?: unknown,
): ObserveDecisionCompositionFailure => ({
  _tag: 'ObserveDecisionCompositionFailure',
  operation,
  message,
  cause,
})

const reconciliationOperationalError = (cause: ReconciliationPassError): OperationalError => {
  switch (cause._tag) {
    case 'BrokerReadError':
      return operationalError('market-data', 'reconciliation', 'same-pass broker reconciliation read failed', cause)
    case 'PaperStoreError':
      return operationalError('database', 'reconciliation', 'same-pass reconciliation store operation failed', cause)
    case 'ReconciliationError':
      return operationalError('strategy', 'reconciliation', 'same-pass reconciliation failed', cause)
    case 'WriterFenceError':
      return operationalError('database', 'reconciliation', 'same-pass reconciliation fence operation failed', cause)
  }
}

const operationalDecisionFailure = (component: OperationalError['component']): CycleDecisionBuildError['failure'] => {
  switch (component) {
    case 'database':
      return 'database'
    case 'market-data':
      return 'market-data'
    case 'config':
    case 'http':
    case 'journal':
    case 'strategy':
      return 'operational'
  }
}

const decisionBuildError = (cause: ObserveDecisionFailure): CycleDecisionBuildError => {
  switch (cause._tag) {
    case 'OperationalError':
      return new CycleDecisionBuildError({
        failure: operationalDecisionFailure(cause.component),
        message: cause.message,
        cause,
      })
    case 'CycleCalendarQueryRangeOutOfRange':
      return new CycleDecisionBuildError({
        failure: 'contract',
        message: 'cycle decision calendar query construction failed',
        cause,
      })
    case 'ExecutionSessionBindingFailure':
    case 'ObserveDecisionCompositionFailure':
    case 'ShadowDecisionError':
    case 'TargetPlannerFailure':
      return new CycleDecisionBuildError({ failure: 'contract', message: cause.message, cause })
  }
}

const hashObserveMaterial = (
  operation: Extract<
    ObserveDecisionCompositionFailure['operation'],
    'compiled-decision-hash' | 'reference-prices' | 'risk-policy-hash'
  >,
  message: string,
  value: unknown,
): Result.Result<string, ObserveDecisionCompositionFailure> =>
  Result.mapError(
    Result.try(() => canonicalHashV1(value)),
    (cause) => compositionFailure(operation, message, cause),
  )

const referencePrices = (
  signalDate: SignalSessionReferencePrices['signalDate'],
  observedAt: string,
  priceMicros: Readonly<Record<string, string>>,
): Result.Result<SignalSessionReferencePrices, ObserveDecisionCompositionFailure> => {
  const material = {
    schemaVersion: 'bayn.signal-session-reference-prices.v1' as const,
    signalDate,
    observedAt,
    priceMicros,
  }
  return Result.map(
    hashObserveMaterial('reference-prices', 'Signal-session reference prices are not canonicalizable', material),
    (contentHash) => ({ ...material, contentHash }),
  )
}

const prepareObserveDecisionReads = (
  input: ObserveDecisionInput,
): Result.Result<ObserveDecisionReadPreparation, CycleCalendarQueryFailure | ObserveDecisionCompositionFailure> => {
  const snapshotId = input.cycle.bindings.snapshotId
  if (snapshotId === undefined) {
    return Result.fail(compositionFailure('cycle-binding', 'active autonomous cycle has no immutable snapshot binding'))
  }
  return Result.map(marketCalendarQueryForSignal(input.cycle.identity.signalSessionDate), (marketCalendarQuery) => ({
    snapshotId,
    marketCalendarQuery,
  }))
}

const readObserveDecisionFacts = (
  input: ObserveDecisionInput,
  preparation: ObserveDecisionReadPreparation,
): Effect.Effect<ObserveDecisionFacts, OperationalError> =>
  Effect.gen(function* () {
    const [snapshot, calendar, reconciliation] = yield* Effect.all(
      [
        input.marketData
          .loadSnapshotPublication({
            snapshotId: preparation.snapshotId,
            signalSessionDate: input.cycle.identity.signalSessionDate,
            signalCalendarVersion: input.cycle.identity.signalCalendarVersion,
          })
          .pipe(
            Effect.mapError((cause) =>
              operationalError(
                'market-data',
                'load-snapshot-publication',
                'bound cycle snapshot publication read failed',
                cause,
              ),
            ),
          ),
        input
          .marketCalendar(preparation.marketCalendarQuery)
          .pipe(
            Effect.mapError((cause) =>
              operationalError('market-data', 'market-calendar', 'execution-session calendar read failed', cause),
            ),
          ),
        input.reconcile.pipe(Effect.mapError(reconciliationOperationalError)),
      ],
      { concurrency: 3 },
    )
    const evaluatedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    return { snapshot, calendar, reconciliation, evaluatedAt }
  })

const requireObserveAuthority = (
  result: ReconciliationPassResult,
  policy: Policy,
  authorityGenerationHash: string,
): Result.Result<ObserveAuthorityObservation, ObserveDecisionCompositionFailure> => {
  const authority = result.riskContext.authority
  if (
    authority === null ||
    result.riskContext.authorityObservedAt === null ||
    authority.generationHash !== authorityGenerationHash ||
    authority.maximum !== Authority.Observe ||
    authority.effective !== Authority.Observe ||
    result.brokerState.account.accountId !== policy.accountId
  ) {
    return Result.fail(
      compositionFailure(
        'observe-authority',
        'same-pass reconciliation did not return the configured OBSERVE authority',
      ),
    )
  }
  return Result.succeed({ authority, observedAt: result.riskContext.authorityObservedAt })
}

const prepareExecutionSessionBinding = (
  input: ObserveDecisionInput,
  facts: ObserveDecisionFacts,
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure | ObserveDecisionCompositionFailure> => {
  const finalizedSnapshot = facts.snapshot.manifest.finalizedSnapshot
  return Result.flatMap(
    Result.mapError(reconciledStateHash(facts.reconciliation.brokerState), (cause) =>
      compositionFailure('reconciled-state-hash', 'same-pass reconciled broker state is not canonicalizable', cause),
    ),
    (contentHash) =>
      bindCycleExecutionSession({
        cycle: input.cycle,
        signal: {
          sessionDate: input.cycle.identity.signalSessionDate,
          finalizedAt: finalizedSnapshot.finalizedAt,
          contentHash: finalizedSnapshot.contentHash,
        },
        planningBrokerState: {
          observedAt: facts.reconciliation.brokerState.reconciliation.reconciledAt,
          contentHash,
        },
        calendar: facts.calendar.value,
        executionModel: input.executionModel,
      }),
  )
}

const compileObserveStrategyDecision = (
  input: ObserveDecisionInput,
  facts: ObserveDecisionFacts,
  executionSession: ExecutionSessionBinding,
): Effect.Effect<CurrentStrategyDecision, OperationalError> =>
  Effect.try({
    try: () => input.strategy.currentDecision(facts.snapshot.bars, facts.snapshot.manifest, executionSession),
    catch: (cause) =>
      operationalError('strategy', 'current-decision', 'current strategy decision compilation failed', cause),
  }).pipe(
    Effect.flatMap(Effect.fromResult),
    Effect.mapError((cause) =>
      cause._tag === 'OperationalError'
        ? cause
        : operationalError('strategy', 'current-decision', 'current strategy decision compilation failed', cause),
    ),
  )

const prepareObservePlanner = (
  input: ObserveDecisionInput,
  facts: ObserveDecisionFacts,
  compiled: CurrentStrategyDecision,
): Result.Result<ObservePlannerPreparation, ObserveDecisionCompositionFailure> =>
  Result.flatMap(referencePrices(compiled.decision.signalDate, facts.evaluatedAt, compiled.priceMicros), (prices) =>
    Result.flatMap(
      hashObserveMaterial('risk-policy-hash', 'OBSERVE risk policy is not canonicalizable', input.policy),
      (policyHash) =>
        Result.map(
          hashObserveMaterial(
            'compiled-decision-hash',
            'current strategy decision is not canonicalizable',
            compiled.decision,
          ),
          (decisionHash) => ({
            prices,
            plannerInput: {
              schemaVersion: 'bayn.paper-target-planner-input.v1',
              strategyName: input.cycle.identity.strategyName,
              cycleId: input.cycle.identity.cycleId,
              decisionHash,
              policyHash,
              accountId: input.cycle.identity.accountId,
              signalDate: input.cycle.identity.signalSessionDate,
              targetWeights: compiled.decision.targetWeights,
              referencePrices: prices,
              brokerState: facts.reconciliation.brokerState,
              precision: input.executionModel.precision,
              maximumInputAgeMs: Math.min(input.policy.maxBrokerStateAgeMs, input.policy.maxMarketDataAgeMs),
              submissionCutoffAt: input.cycle.window.submissionCutoffAt,
              observedAt: facts.evaluatedAt,
            },
          }),
        ),
    ),
  )

const reduceObserveRiskInputs = (
  input: ObserveDecisionInput,
  facts: ObserveDecisionFacts,
  authorityObservation: ObserveAuthorityObservation,
  executionSession: ExecutionSessionBinding,
  targetPlan: TargetPlanResult,
  prices: SignalSessionReferencePrices,
): Result.Result<readonly ShadowDeltaRiskInput[], ObserveDecisionCompositionFailure> =>
  Result.mapError(
    Result.all(
      targetPlan.intentTargets.map((target) => {
        const referencePrice = BigInt(prices.priceMicros[target.symbol])
        return Result.map(
          makeFillTerms(
            target.side === OrderSide.Buy ? 'buy' : 'sell',
            BigInt(target.quantityMicros),
            referencePrice,
            input.executionModel,
            MICROS,
          ),
          (fillTerms): ShadowDeltaRiskInput => {
            const reconciliation = facts.reconciliation
            const finalizedSnapshot = facts.snapshot.manifest.finalizedSnapshot
            const state: State = {
              schemaVersion: 'bayn.paper-risk-state.v2',
              brokerMode: BrokerMode.Paper,
              account: reconciliation.brokerState.account,
              positions: reconciliation.brokerState.positions,
              positionsObservedAt: reconciliation.brokerState.positionsObservedAt,
              orders: reconciliation.brokerState.orders,
              ordersObservedAt: reconciliation.brokerState.ordersObservedAt,
              reconciliation: reconciliation.brokerState.reconciliation,
              authority: authorityObservation.authority,
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
              marketDataObservedAt: facts.evaluatedAt,
              executionSession,
              reservedBuyingPowerMicros: '0',
              evaluatedAt: facts.evaluatedAt,
            }
            return {
              symbol: target.symbol,
              notionalLimitMicros: fillTerms.notionalMicros.toString(),
              state,
            }
          },
        )
      }),
    ),
    (cause) => compositionFailure('shadow-risk-inputs', 'shadow risk input construction failed', cause),
  )

export const buildObserveCycleDecision = (
  input: ObserveDecisionInput,
): Effect.Effect<ObserveShadowDecisionDocument, ObserveDecisionFailure> =>
  Effect.gen(function* () {
    const readPreparation = yield* Effect.fromResult(prepareObserveDecisionReads(input))
    const facts = yield* readObserveDecisionFacts(input, readPreparation)
    const authorityObservation = yield* Effect.fromResult(
      requireObserveAuthority(facts.reconciliation, input.policy, input.authorityGenerationHash),
    )
    const executionSession = yield* Effect.fromResult(prepareExecutionSessionBinding(input, facts))
    const compiled = yield* compileObserveStrategyDecision(input, facts, executionSession)
    const plannerPreparation = yield* Effect.fromResult(prepareObservePlanner(input, facts, compiled))
    const targetPlan = yield* Effect.fromResult(planTargets(plannerPreparation.plannerInput))
    const riskInputs = yield* Effect.fromResult(
      reduceObserveRiskInputs(
        input,
        facts,
        authorityObservation,
        executionSession,
        targetPlan,
        plannerPreparation.prices,
      ),
    )
    const finalizedSnapshot = facts.snapshot.manifest.finalizedSnapshot
    return yield* buildObserveShadowDecision({
      cycle: input.cycle,
      snapshot: {
        snapshotId: finalizedSnapshot.snapshotId,
        contentHash: finalizedSnapshot.contentHash,
        finalizedAt: finalizedSnapshot.finalizedAt,
      },
      compiledDecision: compiled.decision,
      plannerInput: plannerPreparation.plannerInput,
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

export type ObserveAutonomousCycleInput = {
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly maximumAuthority: Authority
  readonly pollIntervalMs: number
  readonly strategy: Pick<Strategy, 'currentDecision' | 'parameters' | 'provenance'>
}

type ObserveRuntime = BrokerRead | CycleStore | MarketData | PaperStore | WriterFence

type ObserveRuntimeServices = {
  readonly brokerRead: BrokerReadShape
  readonly cycleStore: CycleStoreShape
  readonly marketData: MarketDataService
  readonly paperStore: PaperStoreShape
  readonly writerFence: WriterFenceService
}

export type ObserveStartupPreparation = {
  readonly executionModel: CausalProtocol['executionModel']
  readonly executionPolicy: CycleExecutionPolicy
  readonly strategyProtocolHash: string
}

export const prepareObserveStartup = (
  input: ObserveAutonomousCycleInput,
): Result.Result<ObserveStartupPreparation, OperationalError> => {
  const executionModel = input.strategy.parameters.executionModel
  if (input.maximumAuthority !== Authority.Observe) {
    return Result.fail(
      operationalError(
        'config',
        'cycle-loop',
        'PAPER autonomous startup requires the gated Phase B authority generation and dispatch transition',
      ),
    )
  }
  if (executionModel.schemaVersion !== 'bayn.execution-model.v2') {
    return Result.fail(
      operationalError('strategy', 'cycle-loop', 'autonomous cycles require the causal v2 execution model'),
    )
  }
  return Result.map(
    Result.mapError(makeCycleExecutionPolicyFromModel(executionModel), (cause) =>
      operationalError('strategy', 'cycle-policy', 'autonomous cycle execution policy construction failed', cause),
    ),
    (executionPolicy) => ({
      executionModel,
      executionPolicy,
      strategyProtocolHash: makeStrategyProtocolHash(input.strategy.provenance.strategy),
    }),
  )
}

const validateObserveAuthorityInitialization = (
  authority: AuthorityState,
  input: ObserveAutonomousCycleInput,
): Result.Result<AuthorityState, OperationalError> =>
  authority.generationHash !== input.authorityGenerationHash ||
  authority.maximum !== Authority.Observe ||
  authority.effective !== Authority.Observe
    ? Result.fail(
        operationalError('database', 'authority', 'OBSERVE authority initialization returned incompatible state'),
      )
    : Result.succeed(authority)

const initializeObserveAuthority = (
  input: ObserveAutonomousCycleInput,
  paperStore: PaperStoreShape,
): Effect.Effect<AuthorityState, OperationalError> =>
  paperStore
    .ensureAuthorityGeneration({
      generationHash: input.authorityGenerationHash,
      maximum: Authority.Observe,
    })
    .pipe(
      Effect.mapError((cause) =>
        operationalError('database', 'authority', 'OBSERVE authority initialization failed', cause),
      ),
      Effect.flatMap((authority) => Effect.fromResult(validateObserveAuthorityInitialization(authority, input))),
    )

const startObserveAutonomousLoop = (
  input: ObserveAutonomousCycleInput,
  services: ObserveRuntimeServices,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
) => {
  const reconcile = runOnce.pipe(
    Effect.provideService(BrokerRead, services.brokerRead),
    Effect.provideService(PaperStore, services.paperStore),
    Effect.provideService(WriterFence, services.writerFence),
  )
  return startAutonomousCycleLoop({
    context: Effect.succeed({
      qualificationRunId: startup.qualificationRunId,
      strategyProtocolHash: preparation.strategyProtocolHash,
      accountId: input.accountId,
      executionPolicy: preparation.executionPolicy,
      buildDecision: (cycle) =>
        buildObserveCycleDecision({
          authorityGenerationHash: input.authorityGenerationHash,
          cycle,
          executionModel: preparation.executionModel,
          marketCalendar: services.brokerRead.marketCalendar,
          marketData: services.marketData,
          policy,
          reconcile,
          strategy: input.strategy,
        }).pipe(Effect.mapError(decisionBuildError)),
    }),
    observePass: (observation) => observePass(startup.recordPass, observation),
    pollIntervalMs: input.pollIntervalMs,
  }).pipe(
    Effect.mapError((cause) =>
      operationalError('strategy', 'cycle-loop', 'autonomous cycle loop failed to start', cause),
    ),
    Effect.map((loop) =>
      loop.pipe(
        Effect.provideService(BrokerRead, services.brokerRead),
        Effect.provideService(CycleStore, services.cycleStore),
        Effect.provideService(MarketData, services.marketData),
      ),
    ),
  )
}

export const makeObserveAutonomousCycleStartup =
  (input: ObserveAutonomousCycleInput): AutonomousCycleStartup<ObserveRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      const policy = yield* loadObserveRiskPolicy(input.accountId, input.strategy.parameters.universe).pipe(
        Effect.mapError((cause) =>
          operationalError('strategy', 'risk-policy', 'source-controlled paper risk policy is invalid', cause),
        ),
      )
      const services: ObserveRuntimeServices = {
        brokerRead: yield* BrokerRead,
        cycleStore: yield* CycleStore,
        marketData: yield* MarketData,
        paperStore: yield* PaperStore,
        writerFence: yield* WriterFence,
      }
      yield* initializeObserveAuthority(input, services.paperStore)
      return yield* startObserveAutonomousLoop(input, services, startup, preparation, policy)
    })
