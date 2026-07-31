import { Clock, Data, Duration, Effect, Option, Ref, Result } from 'effect'

import type { AutonomousCycleLoop, AutonomousCycleStartup } from './app'
import { BrokerRead, type BrokerReadShape, type MarketCalendarQuery } from './broker/alpaca'
import {
  CycleState,
  CycleTerminalReason,
  makeCycleExecutionPolicyFromModel,
  type AutonomousCycle,
  type CycleExecutionPolicy,
} from './cycle'
import {
  CycleDecisionBuildError,
  CycleRunnerError,
  cyclePassLogFacts,
  decideIdleReconciliationCadence,
  marketCalendarQueryForSignal,
  runAutonomousCyclePass,
  shouldDeferCyclePollForReconciliation,
  validateCyclePassTimeout,
  validateReconciliationInterval,
  type CycleRunContext,
  type CyclePassObservation,
  type CycleRunResult,
} from './cycle-runner'
import { validateCycleLoopInterval } from './cycle-runner/decisions'
import { CycleNotDueReconciliationError, type ReconciliationCadenceState } from './cycle-runner/model'
import { CycleStore } from './db/cycle-store'
import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from './db/execution-store'
import { WriterFence } from './execution/writer-fence'
import { MutationOperation } from './broker/alpaca-mutations'
import { recover as recoverMutation } from './execution/coordinator'
import { BrokerAccess, CapitalAuthorityKind } from './execution/authority'
import { IntentStore, planPaperIntent, type StoredIntent } from './execution/intents'
import { MutationEventType, MutationStore, type MutationEvent } from './execution/mutations'
import type { ExecutionProgram } from './execution/runtime-program'
import {
  bindCycleExecutionSession,
  type ExecutionSessionBinding,
  type ExecutionSessionBindingFailure,
} from './execution-session'
import { makeFillTerms, MICROS } from './execution-model'
import { makeStrategyProtocolHash } from './contracts'
import { OperationalError, operationalError } from './errors'
import { canonicalHashV1Result } from './hash'
import { MarketData, type MarketDataService } from './market-data'
import {
  Authority,
  IntentState,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TerminalOutcome,
  TimeInForce,
  type AuthorityState,
  type Intent,
  type Order,
  type Position,
} from './execution/contracts'
import type { CausalProtocol } from './protocol'
import { runOnce, type ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, decodePolicy, type Policy, type State } from './risk'
import {
  buildObserveShadowDecision,
  buildPaperDecision,
  type ShadowDecisionError,
  type ShadowDeltaRiskInput,
} from './shadow-decision'
import type {
  CycleDecisionDocument,
  ObserveShadowDecisionDocument,
  PaperDecisionDocument,
} from './shadow-decision-contract'
import { currentUtcInstant } from './time'
import {
  planTargets,
  TargetPlanStatus,
  type PlannedTargetQuantity,
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

class ReconciliationPassTimeoutError extends Data.TaggedError('ReconciliationPassTimeoutError')<{
  readonly timeoutMs: number
  readonly message: string
}> {}

type ReconciliationPassError = Effect.Error<typeof runOnce> | ReconciliationPassTimeoutError

const boundedReconciliationPass = (
  timeoutMs: number,
): Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime> =>
  runOnce.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new ReconciliationPassTimeoutError({
            timeoutMs,
            message: `same-pass broker reconciliation timed out after ${timeoutMs.toString()}ms`,
          }),
        ),
    }),
  )

const mutationCyclePassTimeoutError = (timeoutMs: number): CycleRunnerError =>
  new CycleRunnerError({
    operation: 'run-cycle-pass',
    failure: 'operational',
    message: `mutation autonomous cycle pass did not complete or reconcile within ${timeoutMs.toString()}ms`,
  })

const runMutationPassWithinTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<A, E | CycleRunnerError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Effect.fail(mutationCyclePassTimeoutError(timeoutMs)),
    }),
  )

export type ObserveDecisionInput<R = never> = {
  readonly authorityGenerationHash: string
  readonly cycle: AutonomousCycle
  readonly executionModel: CausalProtocol['executionModel']
  readonly policy: Policy
  readonly reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, R>
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
    case 'ExecutionStoreError':
      return operationalError('database', 'reconciliation', 'same-pass reconciliation store operation failed', cause)
    case 'ReconciliationError':
      return operationalError('strategy', 'reconciliation', 'same-pass reconciliation failed', cause)
    case 'WriterFenceError':
      return operationalError('database', 'reconciliation', 'same-pass reconciliation fence operation failed', cause)
    case 'ReconciliationPassTimeoutError':
      return new OperationalError({
        component: 'market-data',
        operation: 'reconciliation',
        message: cause.message,
        retryable: false,
        cause,
      })
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

const notDueReconciliationError = (cause: ReconciliationPassError): CycleNotDueReconciliationError => {
  const operational = reconciliationOperationalError(cause)
  return new CycleNotDueReconciliationError({
    failure: operationalDecisionFailure(operational.component),
    message: operational.message,
    cause: operational,
  })
}

const hashObserveMaterial = (
  operation: Extract<
    ObserveDecisionCompositionFailure['operation'],
    'compiled-decision-hash' | 'reference-prices' | 'risk-policy-hash'
  >,
  message: string,
  value: unknown,
): Result.Result<string, ObserveDecisionCompositionFailure> =>
  Result.mapError(canonicalHashV1Result(value), (cause) => compositionFailure(operation, message, cause))

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

const prepareObserveDecisionReads = <R>(
  input: ObserveDecisionInput<R>,
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

const readObserveDecisionFacts = <R>(
  input: ObserveDecisionInput<R>,
  preparation: ObserveDecisionReadPreparation,
): Effect.Effect<ObserveDecisionFacts, OperationalError, BrokerRead | MarketData | R> =>
  Effect.gen(function* () {
    const brokerRead = yield* BrokerRead
    const marketData = yield* MarketData
    const [snapshot, calendar, reconciliation] = yield* Effect.all(
      [
        marketData
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
        brokerRead
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
    const evaluatedAt = yield* currentUtcInstant
    return { snapshot, calendar, reconciliation, evaluatedAt }
  })

type DecisionAuthorityRequirement = Authority.Observe | Authority.Paper

const requireDecisionAuthority = (
  result: ReconciliationPassResult,
  policy: Policy,
  authorityGenerationHash: string,
  required: DecisionAuthorityRequirement,
): Result.Result<ObserveAuthorityObservation, ObserveDecisionCompositionFailure> => {
  const authority = result.riskContext.authority
  if (
    authority === null ||
    result.riskContext.authorityObservedAt === null ||
    authority.generationHash !== authorityGenerationHash ||
    authority.maximum !== required ||
    authority.effective !== required ||
    result.brokerState.account.accountId !== policy.accountId
  ) {
    return Result.fail(
      compositionFailure(
        'observe-authority',
        `same-pass reconciliation did not return the configured ${required} authority`,
      ),
    )
  }
  return Result.succeed({ authority, observedAt: result.riskContext.authorityObservedAt })
}

const requireMutationAuthorityGeneration = (
  result: ReconciliationPassResult,
  policy: Policy,
  authorityGenerationHash: string,
): Result.Result<ObserveAuthorityObservation, ObserveDecisionCompositionFailure> => {
  const authority = result.riskContext.authority
  if (
    authority === null ||
    result.riskContext.authorityObservedAt === null ||
    authority.generationHash !== authorityGenerationHash ||
    authority.maximum !== Authority.Paper ||
    result.brokerState.account.accountId !== policy.accountId
  ) {
    return Result.fail(
      compositionFailure(
        'observe-authority',
        'same-pass reconciliation did not return the configured PAPER authority generation',
      ),
    )
  }
  return Result.succeed({ authority, observedAt: result.riskContext.authorityObservedAt })
}

const prepareExecutionSessionBinding = <R>(
  input: ObserveDecisionInput<R>,
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

const compileObserveStrategyDecision = <R>(
  input: ObserveDecisionInput<R>,
  facts: ObserveDecisionFacts,
  executionSession: ExecutionSessionBinding,
): Effect.Effect<CurrentStrategyDecision, OperationalError> =>
  Effect.fromResult(
    input.strategy.currentDecision(facts.snapshot.bars, facts.snapshot.manifest, executionSession),
  ).pipe(
    Effect.mapError((cause) =>
      operationalError('strategy', 'current-decision', 'current strategy decision compilation failed', cause),
    ),
  )

const prepareObservePlanner = <R>(
  input: ObserveDecisionInput<R>,
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

const reduceObserveRiskInputs = <R>(
  input: ObserveDecisionInput<R>,
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

export const buildObserveCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
): Effect.Effect<ObserveShadowDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R> =>
  buildCycleDecision(input, Authority.Observe)

function buildCycleDecision<R>(
  input: ObserveDecisionInput<R>,
  authorityRequirement: Authority.Observe,
): Effect.Effect<ObserveShadowDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R>
function buildCycleDecision<R>(
  input: ObserveDecisionInput<R>,
  authorityRequirement: Authority.Paper,
): Effect.Effect<PaperDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R>
function buildCycleDecision<R>(
  input: ObserveDecisionInput<R>,
  authorityRequirement: DecisionAuthorityRequirement,
): Effect.Effect<CycleDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R> {
  return Effect.gen(function* () {
    const readPreparation = yield* Effect.fromResult(prepareObserveDecisionReads(input))
    const facts = yield* readObserveDecisionFacts(input, readPreparation)
    const executionAuthority = yield* Effect.fromResult(
      requireDecisionAuthority(facts.reconciliation, input.policy, input.authorityGenerationHash, authorityRequirement),
    )
    const executionSession = yield* Effect.fromResult(prepareExecutionSessionBinding(input, facts))
    const compiled = yield* compileObserveStrategyDecision(input, facts, executionSession)
    const plannerPreparation = yield* Effect.fromResult(prepareObservePlanner(input, facts, compiled))
    const targetPlan = yield* Effect.fromResult(planTargets(plannerPreparation.plannerInput))
    const riskInputs = yield* Effect.fromResult(
      reduceObserveRiskInputs(
        input,
        facts,
        executionAuthority,
        executionSession,
        targetPlan,
        plannerPreparation.prices,
      ),
    )
    const finalizedSnapshot = facts.snapshot.manifest.finalizedSnapshot
    const decisionInput = {
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
    }
    return authorityRequirement === Authority.Observe
      ? yield* buildObserveShadowDecision(decisionInput)
      : yield* buildPaperDecision({ ...decisionInput, authorityGenerationHash: input.authorityGenerationHash })
  })
}

export const buildMutationShadowCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
): Effect.Effect<PaperDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R> =>
  buildCycleDecision(input, Authority.Paper)

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
  readonly pollIntervalMs: number
  readonly reconciliationIntervalMs: number
  readonly reconciliationPassTimeoutMs: number
  readonly strategy: Pick<Strategy, 'currentDecision' | 'parameters' | 'provenance'>
}

type ObserveDecisionRuntime =
  | BrokerRead
  | MarketData
  | BrokerEventStore
  | FillAccountingStore
  | ValuationStore
  | ReconciliationStore
  | AuthorityGenerationStore
  | AuthorityRestrictionStore
  | WriterFence
type ObserveRuntime = CycleStore | ObserveDecisionRuntime
type RecoveryFirstRuntime = ObserveRuntime | IntentStore | MutationStore

export type ObserveStartupPreparation = {
  readonly executionModel: CausalProtocol['executionModel']
  readonly executionPolicy: CycleExecutionPolicy
  readonly strategyProtocolHash: string
}

export const prepareObserveStartup = (
  input: ObserveAutonomousCycleInput,
): Result.Result<ObserveStartupPreparation, OperationalError> => {
  const executionModel = input.strategy.parameters.executionModel
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
): Effect.Effect<AuthorityState, OperationalError, AuthorityGenerationStore> =>
  AuthorityGenerationStore.pipe(
    Effect.flatMap((executionStore) =>
      executionStore.ensureAuthorityGeneration({
        generationHash: input.authorityGenerationHash,
        maximum: Authority.Observe,
      }),
    ),
    Effect.mapError((cause) =>
      operationalError('database', 'authority', 'OBSERVE authority initialization failed', cause),
    ),
    Effect.flatMap((authority) => Effect.fromResult(validateObserveAuthorityInitialization(authority, input))),
  )

const mutationConsistencyDelayMs = 1_000
const quantityScale = 1_000_000n

export type MutationAutonomousCycleInput = ObserveAutonomousCycleInput & {
  readonly executionProgram: ExecutionProgram
}

type PaperExecutionCapability =
  | { readonly _tag: 'RecoveryOnly' }
  | { readonly _tag: 'Mutation'; readonly executionProgram: ExecutionProgram }

type PaperMutationExecutor<E, R> = {
  readonly submit?: (intentId: string, consistencyDelayMs: number) => Effect.Effect<MutationEvent, E, R>
  readonly recover: (intentId: string, operation: MutationOperation) => Effect.Effect<MutationEvent, E, R>
}

type RecoveryFirstDecisionBuilder = (
  cycle: AutonomousCycle,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
) => Effect.Effect<CycleDecisionDocument, CycleDecisionBuildError, ObserveDecisionRuntime>

const mutationRunnerError = (
  message: string,
  cause?: unknown,
  failure: CycleRunnerError['failure'] = 'operational',
): CycleRunnerError =>
  new CycleRunnerError({
    operation: 'recover-cycle',
    failure,
    message,
    cause,
  })

const configuredMutationGeneration = (input: MutationAutonomousCycleInput): string | undefined => {
  const capital = input.executionProgram.authority.capitalAuthority
  switch (capital._tag) {
    case CapitalAuthorityKind.Sandbox:
      return capital.authorityGenerationHash
    case CapitalAuthorityKind.LiveGrant:
      return capital.grant.authorityGenerationHash
  }
}

const validateMutationExecutionProgram = (
  input: MutationAutonomousCycleInput,
): Result.Result<void, OperationalError> => {
  const authority = input.executionProgram.authority
  const generationHash = configuredMutationGeneration(input)
  const strategy = input.strategy.provenance.strategy
  return authority.brokerAccess !== BrokerAccess.Mutation ||
    generationHash === undefined ||
    generationHash !== input.authorityGenerationHash ||
    authority.brokerIdentity.accountId !== input.accountId ||
    authority.strategy.name !== strategy.name ||
    authority.strategy.behaviorHash !== strategy.behaviorHash ||
    authority.strategy.parameterHash !== strategy.parameterHash ||
    authority.strategy.parameterSchemaVersion !== strategy.parameterSchemaVersion
    ? Result.fail(
        operationalError(
          'config',
          'cycle-loop',
          'mutation cycle execution program does not match its account, authority generation, and strategy',
        ),
      )
    : Result.succeed(undefined)
}

const comparePositionSymbol = (left: Position, right: Position): number =>
  left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0

const divideAwayFromZero = (numerator: bigint): bigint => {
  const magnitude = numerator < 0n ? -numerator : numerator
  const rounded = magnitude === 0n ? 0n : (magnitude + quantityScale - 1n) / quantityScale
  return numerator < 0n ? -rounded : rounded
}

const projectMutationPosition = (
  positions: readonly Position[],
  target: PlannedTargetQuantity,
  accountId: string,
  observedAt: string,
): readonly Position[] => {
  const retained = positions.filter((position) => position.symbol !== target.symbol)
  const quantity = BigInt(target.targetQuantityMicros)
  if (quantity === 0n) return retained
  const previous = positions.find((position) => position.symbol === target.symbol)
  const referencePrice = BigInt(target.referencePriceMicros)
  const averageEntryPrice = BigInt(previous?.averageEntryPriceMicros ?? target.referencePriceMicros)
  const projected: Position = {
    schemaVersion: 'bayn.paper-position.v1',
    accountId: previous?.accountId ?? accountId,
    symbol: target.symbol,
    quantityMicros: target.targetQuantityMicros,
    averageEntryPriceMicros: averageEntryPrice.toString(),
    marketPriceMicros: target.referencePriceMicros,
    marketValueMicros: divideAwayFromZero(quantity * referencePrice).toString(),
    unrealizedPnlMicros: divideAwayFromZero(quantity * (referencePrice - averageEntryPrice)).toString(),
    observedAt: previous?.observedAt ?? observedAt,
  }
  return [...retained, projected].sort(comparePositionSymbol)
}

export const projectWorstCasePendingMutationPosition = (
  positions: readonly Position[],
  target: PlannedTargetQuantity,
  accountId: string,
  observedAt: string,
): readonly Position[] => {
  const current = positions.find((position) => position.symbol === target.symbol)
  const currentQuantity = current === undefined ? 0n : BigInt(current.quantityMicros)
  const targetQuantity = BigInt(target.targetQuantityMicros)
  return targetQuantity <= currentQuantity
    ? positions
    : projectMutationPosition(positions, target, accountId, observedAt)
}

const validateBoundMutationDocument = (
  input: ObserveAutonomousCycleInput,
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
): Result.Result<void, CycleRunnerError> => {
  return cycle.state !== CycleState.Active ||
    cycle.bindings.decisionHash !== document.contentHash ||
    cycle.bindings.snapshotId !== document.bindings.snapshotId ||
    cycle.identity.cycleId !== document.bindings.cycleId ||
    cycle.identity.qualificationRunId !== document.bindings.qualificationRunId ||
    cycle.identity.accountId !== document.bindings.accountId ||
    cycle.identity.strategyProtocolHash !== document.bindings.strategyProtocolHash ||
    input.accountId !== document.bindings.accountId
    ? Result.fail(
        mutationRunnerError(
          'durable shadow plan does not match the mutation cycle account, protocol, and decision binding',
          undefined,
          'contract',
        ),
      )
    : Result.succeed(undefined)
}

const validateCurrentMutationPolicy = (
  policy: Policy,
  document: PaperDecisionDocument,
): Result.Result<void, CycleRunnerError> => {
  const policyHash = canonicalHashV1Result(policy)
  if (Result.isFailure(policyHash)) {
    return Result.fail(mutationRunnerError('mutation cycle risk policy is not canonicalizable', policyHash.failure))
  }
  return policyHash.success !== document.bindings.policyHash
    ? Result.fail(
        mutationRunnerError(
          'current source-controlled PAPER risk policy changed from the durable decision binding',
          undefined,
          'contract',
        ),
      )
    : Result.succeed(undefined)
}

const readBoundMutationDocument = (
  cycle: AutonomousCycle,
): Effect.Effect<CycleDecisionDocument, CycleRunnerError, CycleStore> =>
  CycleStore.pipe(
    Effect.flatMap((store) => store.readDecisionDocument(cycle.identity.cycleId)),
    Effect.mapError((cause) => mutationRunnerError('durable mutation-cycle shadow plan read failed', cause, 'store')),
    Effect.flatMap((document) =>
      Option.match(document, {
        onNone: () =>
          Effect.fail(
            mutationRunnerError('decision-bound mutation cycle is missing its durable shadow plan', undefined, 'store'),
          ),
        onSome: Effect.succeed,
      }),
    ),
  )

const mutationDecisionInput = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): ObserveDecisionInput<ObserveDecisionRuntime> => ({
  authorityGenerationHash: input.authorityGenerationHash,
  cycle,
  executionModel: preparation.executionModel,
  policy,
  reconcile,
  strategy: input.strategy,
})

export type PreparedMutationIntentDecision =
  | { readonly _tag: 'Submit' }
  | { readonly _tag: 'Recover'; readonly eventType: MutationEventType }
  | { readonly _tag: 'Pending'; readonly order: Order }
  | { readonly _tag: 'SkipTerminal' }

export type PreparedMutationIntentDecisionFailure = {
  readonly _tag: 'PreparedMutationIntentDecisionFailure'
  readonly intentId: string
  readonly message: string
  readonly eventType?: MutationEventType
}

export const decidePreparedMutationIntent = (
  intent: Intent,
  latest: MutationEvent | undefined,
): Result.Result<PreparedMutationIntentDecision, PreparedMutationIntentDecisionFailure> => {
  if (intent.state === IntentState.Terminal) return Result.succeed({ _tag: 'SkipTerminal' })
  if (latest === undefined) return Result.succeed({ _tag: 'Submit' })
  switch (latest.eventType) {
    case MutationEventType.SubmitAccepted:
    case MutationEventType.RecoveryFound:
      return latest.brokerOrderId === undefined
        ? Result.fail({
            _tag: 'PreparedMutationIntentDecisionFailure',
            intentId: intent.intentId,
            eventType: latest.eventType,
            message: 'accepted nonterminal submit lacks a durable broker order identity',
          })
        : Result.succeed({
            _tag: 'Pending',
            order: {
              schemaVersion: 'bayn.paper-order.v1',
              accountId: intent.accountId,
              brokerOrderId: latest.brokerOrderId,
              clientOrderId: intent.clientOrderId,
              intentId: intent.intentId,
              symbol: intent.symbol,
              side: intent.side,
              orderType: intent.orderType,
              timeInForce: intent.timeInForce,
              quantityMicros: intent.quantityMicros,
              filledQuantityMicros: '0',
              status: OrderStatus.New,
              observedAt: latest.occurredAt,
            },
          })
    case MutationEventType.SubmitRejected:
    case MutationEventType.SubmitDenied:
      return Result.fail({
        _tag: 'PreparedMutationIntentDecisionFailure',
        intentId: intent.intentId,
        eventType: latest.eventType,
        message: 'terminal submit event does not match the nonterminal durable intent state',
      })
    case MutationEventType.SubmitStarted:
    case MutationEventType.SubmitUnknown:
    case MutationEventType.RecoveryNotFound:
    case MutationEventType.RecoveryUnknown:
    case MutationEventType.CancelStarted:
    case MutationEventType.CancelAccepted:
    case MutationEventType.CancelUnknown:
      return Result.succeed({ _tag: 'Recover', eventType: latest.eventType })
  }
}

export type PreparedMutationIntentAdmissionFailure = {
  readonly _tag: 'PreparedMutationIntentAdmissionFailure'
  readonly reason:
    | 'accounting-inexact'
    | 'authority'
    | 'expiry'
    | 'reconciliation-not-exact'
    | 'unknown-mutation'
    | 'unknown-order'
  readonly message: string
}

export const decidePreparedMutationIntentAdmission = (
  prepared: PreparedMutationIntentDecision,
  effectiveAuthority: Authority,
  observedAt: string,
  expiresAt: string,
  unknownMutationCount: number,
  reconciliationStatus: ReconciliationStatus = ReconciliationStatus.Exact,
  accountingExact = true,
  unknownOrderCount = 0,
): Result.Result<void, PreparedMutationIntentAdmissionFailure> => {
  if (prepared._tag !== 'Submit') return Result.succeed(undefined)
  if (effectiveAuthority !== Authority.Paper) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'authority',
      message: 'fresh PAPER submit requires current effective PAPER authority',
    })
  }
  if (observedAt >= expiresAt) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'expiry',
      message: 'fresh PAPER submit is forbidden at or after decision expiry',
    })
  }
  if (reconciliationStatus !== ReconciliationStatus.Exact) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'reconciliation-not-exact',
      message: 'fresh PAPER submit requires exact same-pass reconciliation',
    })
  }
  if (!accountingExact) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'accounting-inexact',
      message: 'fresh PAPER submit requires exact same-pass accounting',
    })
  }
  if (unknownMutationCount !== 0) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'unknown-mutation',
      message: 'fresh PAPER submit is forbidden while a mutation outcome is unknown',
    })
  }
  if (unknownOrderCount !== 0) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'unknown-order',
      message: 'fresh PAPER submit is forbidden while a broker order is unknown',
    })
  }
  return Result.succeed(undefined)
}

export const appendPendingMutationOrder = (orders: readonly Order[], pending: Order): readonly Order[] =>
  orders.some((order) => order.brokerOrderId === pending.brokerOrderId || order.clientOrderId === pending.clientOrderId)
    ? orders
    : [...orders, pending]

export interface PaperCycleIntentTerminalEvidence {
  readonly state: IntentState
  readonly terminalOutcome?: TerminalOutcome
  readonly updatedAt: string
  readonly latestMutationAt?: string
}

export interface PaperCycleReconciliationEvidence {
  readonly status: ReconciliationStatus
  readonly reconciledAt: string
  readonly accountingExact: boolean
  readonly unknownMutationCount: number
  readonly unknownOrderCount: number
}

export type PaperCycleCompletionDecision =
  | { readonly _tag: 'Complete' }
  | {
      readonly _tag: 'Wait'
      readonly reason:
        | 'accounting-inexact'
        | 'intent-nonterminal'
        | 'intent-unsuccessful'
        | 'reconciliation-not-later'
        | 'reconciliation-not-exact'
        | 'unknown-mutation'
        | 'unknown-order'
    }

export const decidePaperCycleCompletion = (
  documentCreatedAt: string,
  intents: readonly PaperCycleIntentTerminalEvidence[],
  reconciliation: PaperCycleReconciliationEvidence,
): PaperCycleCompletionDecision => {
  if (intents.some((intent) => intent.state !== IntentState.Terminal)) {
    return { _tag: 'Wait', reason: 'intent-nonterminal' }
  }
  if (intents.some((intent) => intent.terminalOutcome !== TerminalOutcome.Filled)) {
    return { _tag: 'Wait', reason: 'intent-unsuccessful' }
  }
  if (reconciliation.status !== ReconciliationStatus.Exact) {
    return { _tag: 'Wait', reason: 'reconciliation-not-exact' }
  }
  if (!reconciliation.accountingExact) return { _tag: 'Wait', reason: 'accounting-inexact' }
  if (reconciliation.unknownMutationCount !== 0) return { _tag: 'Wait', reason: 'unknown-mutation' }
  if (reconciliation.unknownOrderCount !== 0) return { _tag: 'Wait', reason: 'unknown-order' }
  const latestEvidenceAt = Math.max(
    Date.parse(documentCreatedAt),
    ...intents.flatMap((intent) => [
      Date.parse(intent.updatedAt),
      Date.parse(intent.latestMutationAt ?? intent.updatedAt),
    ]),
  )
  if (Date.parse(reconciliation.reconciledAt) <= latestEvidenceAt) {
    return { _tag: 'Wait', reason: 'reconciliation-not-later' }
  }
  return { _tag: 'Complete' }
}

type PreparedPaperIntent = {
  readonly intent: Intent
  readonly targetIntent: PaperDecisionDocument['targetPlan']['intentTargets'][number]
  readonly target: PlannedTargetQuantity
  readonly riskBinding: PaperDecisionDocument['deltaRisk'][number]
  readonly stored: StoredIntent | undefined
  readonly latestSubmit: MutationEvent | undefined
  readonly latestCancel: MutationEvent | undefined
}

type PaperIntentRecoveryLookup = Omit<PreparedPaperIntent, 'intent'> & {
  readonly intentId: string
}

export type PreparedMutationRecoveryDecision =
  | { readonly _tag: 'NoRecovery' }
  | {
      readonly _tag: 'Recover'
      readonly operation: MutationOperation
      readonly event: MutationEvent
    }

export const decidePreparedMutationRecovery = (
  intent: Intent,
  latestSubmit: MutationEvent | undefined,
  latestCancel: MutationEvent | undefined,
): Result.Result<PreparedMutationRecoveryDecision, PreparedMutationIntentDecisionFailure> => {
  if (latestCancel !== undefined) {
    if (latestCancel.operation !== MutationOperation.Cancel) {
      return Result.fail({
        _tag: 'PreparedMutationIntentDecisionFailure',
        intentId: intent.intentId,
        eventType: latestCancel.eventType,
        message: 'durable cancellation recovery read returned a non-cancel mutation',
      })
    }
    return intent.state === IntentState.Terminal && latestCancel.eventType === MutationEventType.RecoveryFound
      ? Result.succeed({ _tag: 'NoRecovery' })
      : Result.succeed({ _tag: 'Recover', operation: MutationOperation.Cancel, event: latestCancel })
  }
  if (latestSubmit === undefined) return Result.succeed({ _tag: 'NoRecovery' })
  if (latestSubmit.operation !== MutationOperation.Submit) {
    return Result.fail({
      _tag: 'PreparedMutationIntentDecisionFailure',
      intentId: intent.intentId,
      eventType: latestSubmit.eventType,
      message: 'durable submit recovery read returned a non-submit mutation',
    })
  }
  if (
    intent.state === IntentState.Terminal &&
    (latestSubmit.eventType === MutationEventType.SubmitAccepted ||
      latestSubmit.eventType === MutationEventType.SubmitRejected ||
      latestSubmit.eventType === MutationEventType.SubmitDenied ||
      latestSubmit.eventType === MutationEventType.RecoveryFound)
  ) {
    return Result.succeed({ _tag: 'NoRecovery' })
  }
  if (
    intent.state !== IntentState.Terminal &&
    (latestSubmit.eventType === MutationEventType.SubmitRejected ||
      latestSubmit.eventType === MutationEventType.SubmitDenied)
  ) {
    return Result.fail({
      _tag: 'PreparedMutationIntentDecisionFailure',
      intentId: intent.intentId,
      eventType: latestSubmit.eventType,
      message: 'terminal submit event does not match the nonterminal durable intent state',
    })
  }
  return Result.succeed({ _tag: 'Recover', operation: MutationOperation.Submit, event: latestSubmit })
}

type PreparedMutationCycleStep =
  | { readonly _tag: 'RunCycle' }
  | {
      readonly _tag: 'Execute'
      readonly action: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL'
      readonly intentId: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'Execute'
      readonly action: 'SUBMIT'
      readonly intentId: string
      readonly observedAt: string
      readonly submitExpiresAt: string
    }
  | {
      readonly _tag: 'Block'
      readonly reason:
        | CycleTerminalReason.MissedSubmission
        | CycleTerminalReason.ProvenanceMismatch
        | CycleTerminalReason.Risk
      readonly observedAt: string
    }
  | { readonly _tag: 'Wait'; readonly observedAt: string }
  | { readonly _tag: 'Complete'; readonly observedAt: string }

type BoundMutationCycleOutcome = Exclude<PreparedMutationCycleStep, { readonly _tag: 'Execute' }>

export const mutationRecoveryIsDue = (event: MutationEvent, observedAt: string): boolean =>
  Date.parse(observedAt) >= Date.parse(event.occurredAt) + event.consistencyDelayMs

export const paperSubmitExpiresAt = (documentExpiresAt: string, riskDecisionExpiresAt: string): string =>
  riskDecisionExpiresAt < documentExpiresAt ? riskDecisionExpiresAt : documentExpiresAt

export const expiredPaperPlanTerminalReason = (
  observedAt: string,
  submitExpiresAt: string,
  submissionCutoffAt: string,
): CycleTerminalReason.MissedSubmission | CycleTerminalReason.Risk | undefined =>
  observedAt < submitExpiresAt
    ? undefined
    : observedAt >= submissionCutoffAt
      ? CycleTerminalReason.MissedSubmission
      : CycleTerminalReason.Risk

const boundPaperSubmissionCutoff = (
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
): Result.Result<string, CycleRunnerError> => {
  if (
    document.submissionCutoffAt !== cycle.window.submissionCutoffAt ||
    document.expiresAt !== cycle.window.submissionCutoffAt
  ) {
    return Result.fail(
      mutationRunnerError(
        'durable PAPER decision changed from its immutable cycle submission window',
        undefined,
        'contract',
      ),
    )
  }
  return Result.succeed(cycle.window.submissionCutoffAt)
}

const immutableIntentBindingMatches = (stored: Intent, expected: Intent): boolean =>
  stored.schemaVersion === expected.schemaVersion &&
  stored.intentId === expected.intentId &&
  stored.authorityGenerationHash === expected.authorityGenerationHash &&
  stored.strategyName === expected.strategyName &&
  stored.cycleId === expected.cycleId &&
  stored.decisionHash === expected.decisionHash &&
  stored.policyHash === expected.policyHash &&
  stored.accountId === expected.accountId &&
  stored.clientOrderId === expected.clientOrderId &&
  stored.symbol === expected.symbol &&
  stored.side === expected.side &&
  stored.orderType === expected.orderType &&
  stored.timeInForce === expected.timeInForce &&
  stored.quantityMicros === expected.quantityMicros &&
  stored.notionalLimitMicros === expected.notionalLimitMicros &&
  stored.createdAt === expected.createdAt

const validateCurrentMutationExecutionTerms = (
  preparation: ObserveStartupPreparation,
  targetIntent: PaperDecisionDocument['targetPlan']['intentTargets'][number],
  target: PlannedTargetQuantity,
  riskBinding: PaperDecisionDocument['deltaRisk'][number],
): Result.Result<void, CycleRunnerError> => {
  const fillTerms = makeFillTerms(
    targetIntent.side === OrderSide.Buy ? 'buy' : 'sell',
    BigInt(targetIntent.quantityMicros),
    BigInt(target.referencePriceMicros),
    preparation.executionModel,
    MICROS,
  )
  if (Result.isFailure(fillTerms)) {
    return Result.fail(mutationRunnerError('mutation execution terms are invalid', fillTerms.failure, 'contract'))
  }
  return fillTerms.success.notionalMicros.toString() === riskBinding.notionalLimitMicros
    ? Result.succeed(undefined)
    : Result.fail(
        mutationRunnerError(
          'durable mutation notional changed from the current execution model',
          undefined,
          'contract',
        ),
      )
}

export const prepareNextMutationIntent = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  allowSubmit = true,
): Effect.Effect<PreparedMutationCycleStep, CycleRunnerError, ObserveDecisionRuntime | IntentStore | MutationStore> =>
  Effect.gen(function* () {
    yield* Effect.fromResult(validateBoundMutationDocument(input, cycle, document))
    const submissionCutoffAt = yield* Effect.fromResult(boundPaperSubmissionCutoff(cycle, document))
    const generationIsSuperseded = input.authorityGenerationHash !== document.bindings.authorityGenerationHash
    if (document.riskBlock !== undefined) {
      return {
        _tag: 'Block',
        reason: CycleTerminalReason.Risk,
        observedAt: yield* currentUtcInstant,
      }
    }
    if (document.targetPlan.status !== TargetPlanStatus.Planned) return { _tag: 'RunCycle' }

    const intentStore = yield* IntentStore
    const mutationStore = yield* MutationStore
    const targets = new Map(document.targetPlan.targets.map((target) => [target.symbol, target]))
    const documentAuthority: AuthorityState = {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: document.bindings.authorityGenerationHash,
      maximum: Authority.Paper,
      effective: Authority.Paper,
      kill: KillState.Clear,
      version: 1,
      updatedAt: document.createdAt,
    }
    const recoveryLookups: PaperIntentRecoveryLookup[] = []

    for (const [index, targetIntent] of document.targetPlan.intentTargets.entries()) {
      const riskBinding = document.deltaRisk[index]
      const target = targets.get(targetIntent.symbol)
      const intentId = document.orderedIntentIds[index]
      if (riskBinding === undefined || target === undefined || intentId === undefined) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable mutation target is missing its intent, risk, or final-position binding',
            undefined,
            'contract',
          ),
        )
      }
      const stored = yield* intentStore
        .read(intentId)
        .pipe(
          Effect.mapError((cause) => mutationRunnerError('durable PAPER intent recovery read failed', cause, 'store')),
        )
      const existing = Option.getOrUndefined(stored)
      const latestSubmit = yield* mutationStore
        .latest(intentId, MutationOperation.Submit)
        .pipe(Effect.mapError((cause) => mutationRunnerError('durable submit state read failed', cause, 'store')))
      const latestCancel = yield* mutationStore
        .latest(intentId, MutationOperation.Cancel)
        .pipe(Effect.mapError((cause) => mutationRunnerError('durable cancel state read failed', cause, 'store')))
      if (existing === undefined && (latestSubmit !== undefined || latestCancel !== undefined)) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable mutation exists without its authority-bound intent',
            { latestSubmit, latestCancel },
            'contract',
          ),
        )
      }
      if (existing !== undefined && existing.intent.intentId !== intentId) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable PAPER intent recovery returned a different intent identity',
            undefined,
            'contract',
          ),
        )
      }
      recoveryLookups.push({
        intentId,
        targetIntent,
        target,
        riskBinding,
        stored: existing,
        latestSubmit,
        latestCancel,
      })
    }

    const preparedIntents: PreparedPaperIntent[] = []
    for (const lookup of recoveryLookups) {
      const intent = yield* planPaperIntent(
        {
          schemaVersion: 'bayn.paper-intent-plan.v1',
          ...lookup.targetIntent,
          notionalLimitMicros: lookup.riskBinding.notionalLimitMicros,
          createdAt: document.createdAt,
        },
        { authority: documentAuthority },
      ).pipe(
        Effect.mapError((cause) =>
          mutationRunnerError('durable PAPER intent reconstruction failed', cause, 'contract'),
        ),
      )
      if (lookup.intentId !== intent.intentId) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable PAPER intent identity or order changed after decision binding',
            undefined,
            'contract',
          ),
        )
      }
      if (lookup.stored !== undefined && !immutableIntentBindingMatches(lookup.stored.intent, intent)) {
        return yield* Effect.fail(
          mutationRunnerError('stored PAPER intent changed from its durable decision binding', undefined, 'contract'),
        )
      }
      preparedIntents.push({ ...lookup, intent })
    }

    const recoveryObservedAt = yield* currentUtcInstant
    for (const prepared of preparedIntents) {
      const existing = prepared.stored
      if (existing === undefined) continue
      const recovery = yield* Effect.fromResult(
        decidePreparedMutationRecovery(existing.intent, prepared.latestSubmit, prepared.latestCancel),
      ).pipe(Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')))
      if (recovery._tag === 'Recover') {
        return mutationRecoveryIsDue(recovery.event, recoveryObservedAt)
          ? {
              _tag: 'Execute',
              action:
                recovery.operation === MutationOperation.Submit
                  ? ('RECOVER_SUBMIT' as const)
                  : ('RECOVER_CANCEL' as const),
              intentId: prepared.intent.intentId,
              observedAt: recoveryObservedAt,
            }
          : { _tag: 'Wait', observedAt: recoveryObservedAt }
      }
    }

    if (generationIsSuperseded) {
      return {
        _tag: 'Block',
        reason: CycleTerminalReason.ProvenanceMismatch,
        observedAt: recoveryObservedAt,
      }
    }

    yield* Effect.fromResult(validateCurrentMutationPolicy(policy, document))

    const uncommittedIntents = preparedIntents.filter((prepared) => prepared.stored === undefined)
    if (!allowSubmit && uncommittedIntents.length > 0) {
      return { _tag: 'Wait', observedAt: recoveryObservedAt }
    }
    if (allowSubmit) {
      for (const prepared of preparedIntents) {
        const requiresFreshSubmission =
          prepared.stored === undefined ||
          (prepared.stored.intent.state !== IntentState.Terminal && prepared.latestSubmit === undefined)
        if (!requiresFreshSubmission) continue
        yield* Effect.fromResult(
          validateCurrentMutationExecutionTerms(
            preparation,
            prepared.targetIntent,
            prepared.target,
            prepared.riskBinding,
          ),
        )
      }
    }
    if (uncommittedIntents.length > 0) {
      const commitObservedAt = yield* currentUtcInstant
      const commitExpiresAt = uncommittedIntents.reduce(
        (expiresAt, prepared) => paperSubmitExpiresAt(expiresAt, prepared.riskBinding.evaluation.decision.expiresAt),
        document.expiresAt,
      )
      const expirationReason = expiredPaperPlanTerminalReason(commitObservedAt, commitExpiresAt, submissionCutoffAt)
      if (expirationReason !== undefined) {
        return {
          _tag: 'Block',
          reason: expirationReason,
          observedAt: commitObservedAt,
        }
      }
      if (
        preparedIntents.some((prepared) => prepared.latestSubmit !== undefined || prepared.latestCancel !== undefined)
      ) {
        return yield* Effect.fail(
          mutationRunnerError(
            'broker mutation evidence exists before the complete immutable intent set was committed',
            undefined,
            'contract',
          ),
        )
      }
    }

    yield* Effect.forEach(
      preparedIntents,
      (prepared) =>
        intentStore
          .commit(prepared.intent, prepared.riskBinding.evaluation.decision)
          .pipe(
            Effect.mapError((cause) => mutationRunnerError('durable PAPER intent-set commit failed', cause, 'store')),
          ),
      { concurrency: 1, discard: true },
    )

    const decisionInput = mutationDecisionInput(input, preparation, policy, cycle, reconcile)
    const reads = yield* Effect.fromResult(prepareObserveDecisionReads(decisionInput)).pipe(
      Effect.mapError((cause) => mutationRunnerError('mutation cycle decision reads are invalid', cause, 'contract')),
    )
    const facts = yield* readObserveDecisionFacts(decisionInput, reads).pipe(
      Effect.mapError((cause) => {
        const converted = decisionBuildError(cause)
        return mutationRunnerError(converted.message, cause, converted.failure)
      }),
    )
    const authority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(facts.reconciliation, policy, input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')))
    if (
      document.bindings.snapshotContentHash !== facts.snapshot.manifest.finalizedSnapshot.contentHash ||
      document.bindings.snapshotFinalizedAt !== facts.snapshot.manifest.finalizedSnapshot.finalizedAt
    ) {
      return yield* Effect.fail(
        mutationRunnerError('bound mutation cycle snapshot publication changed after planning', undefined, 'contract'),
      )
    }

    const terminalEvidence: PaperCycleIntentTerminalEvidence[] = []
    for (const prepared of preparedIntents) {
      const stored = yield* intentStore
        .read(prepared.intent.intentId)
        .pipe(Effect.mapError((cause) => mutationRunnerError('committed PAPER intent readback failed', cause, 'store')))
      const record = Option.getOrUndefined(stored)
      if (record === undefined) {
        return yield* Effect.fail(
          mutationRunnerError('committed PAPER intent disappeared before execution selection', undefined, 'contract'),
        )
      }
      const latest = yield* mutationStore
        .latest(prepared.intent.intentId, MutationOperation.Submit)
        .pipe(Effect.mapError((cause) => mutationRunnerError('durable submit state refresh failed', cause, 'store')))
      const decision = yield* Effect.fromResult(decidePreparedMutationIntent(record.intent, latest)).pipe(
        Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')),
      )
      switch (decision._tag) {
        case 'SkipTerminal':
          terminalEvidence.push({
            state: record.intent.state,
            terminalOutcome: record.intent.terminalOutcome,
            updatedAt: record.updatedAt,
            ...(latest === undefined ? {} : { latestMutationAt: latest.occurredAt }),
          })
          if (record.intent.terminalOutcome !== TerminalOutcome.Filled) {
            yield* restrictMutationAuthority(
              `bound PAPER cycle ${cycle.identity.cycleId}`,
              `intent ${prepared.intent.intentId} ended ${record.intent.terminalOutcome ?? 'without outcome'}`,
            )
            return {
              _tag: 'Block',
              reason: CycleTerminalReason.Risk,
              observedAt: facts.evaluatedAt,
            }
          }
          break
        case 'Pending':
          return latest !== undefined && mutationRecoveryIsDue(latest, facts.evaluatedAt)
            ? {
                _tag: 'Execute',
                action: 'RECOVER_SUBMIT',
                intentId: prepared.intent.intentId,
                observedAt: facts.evaluatedAt,
              }
            : { _tag: 'Wait', observedAt: facts.evaluatedAt }
        case 'Recover':
          return latest !== undefined && mutationRecoveryIsDue(latest, facts.evaluatedAt)
            ? {
                _tag: 'Execute',
                action: 'RECOVER_SUBMIT',
                intentId: prepared.intent.intentId,
                observedAt: facts.evaluatedAt,
              }
            : { _tag: 'Wait', observedAt: facts.evaluatedAt }
        case 'Submit':
          if (!allowSubmit) return { _tag: 'Wait', observedAt: facts.evaluatedAt }
          const submitExpiresAt = paperSubmitExpiresAt(
            submissionCutoffAt,
            prepared.riskBinding.evaluation.decision.expiresAt,
          )
          const expirationReason = expiredPaperPlanTerminalReason(
            facts.evaluatedAt,
            submitExpiresAt,
            submissionCutoffAt,
          )
          if (expirationReason !== undefined) {
            return {
              _tag: 'Block',
              reason: expirationReason,
              observedAt: facts.evaluatedAt,
            }
          }
          yield* Effect.fromResult(
            decidePreparedMutationIntentAdmission(
              decision,
              authority.authority.effective,
              facts.evaluatedAt,
              submitExpiresAt,
              facts.reconciliation.riskContext.unknownMutationCount,
              facts.reconciliation.brokerState.reconciliation.status,
              facts.reconciliation.report.metrics.accountingExact,
              facts.reconciliation.brokerState.unknownOrderCount,
            ),
          ).pipe(Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')))
          return {
            _tag: 'Execute',
            action: 'SUBMIT',
            intentId: prepared.intent.intentId,
            observedAt: facts.evaluatedAt,
            submitExpiresAt,
          }
      }
    }

    const completion = decidePaperCycleCompletion(document.createdAt, terminalEvidence, {
      status: facts.reconciliation.brokerState.reconciliation.status,
      reconciledAt: facts.reconciliation.brokerState.reconciliation.reconciledAt,
      accountingExact: facts.reconciliation.report.metrics.accountingExact,
      unknownMutationCount: facts.reconciliation.riskContext.unknownMutationCount,
      unknownOrderCount: facts.reconciliation.brokerState.unknownOrderCount,
    })
    return completion._tag === 'Complete'
      ? { _tag: 'Complete', observedAt: facts.evaluatedAt }
      : { _tag: 'Wait', observedAt: facts.evaluatedAt }
  })

const submitDoesNotRequireRecovery = (eventType: MutationEventType): boolean =>
  eventType === MutationEventType.SubmitRejected || eventType === MutationEventType.SubmitDenied

export type MutationIntentSettlementDecision =
  | {
      readonly _tag: 'Settled'
      readonly outcome: 'accepted' | 'rejected' | 'denied'
    }
  | {
      readonly _tag: 'Unresolved'
      readonly eventType: MutationEventType
    }

export const decideMutationIntentSettlement = (eventType: MutationEventType): MutationIntentSettlementDecision => {
  switch (eventType) {
    case MutationEventType.SubmitAccepted:
    case MutationEventType.RecoveryFound:
      return { _tag: 'Settled', outcome: 'accepted' }
    case MutationEventType.SubmitRejected:
      return { _tag: 'Settled', outcome: 'rejected' }
    case MutationEventType.SubmitDenied:
      return { _tag: 'Settled', outcome: 'denied' }
    default:
      return { _tag: 'Unresolved', eventType }
  }
}

export interface MutationIntentExecutionResult {
  readonly settlement: Extract<MutationIntentSettlementDecision, { readonly _tag: 'Settled' }>
  readonly consistencyDelayMs: number
  readonly operation: MutationOperation
}

export const mutationIntentReconciliationDelayMs = (result: MutationIntentExecutionResult): number =>
  result.settlement.outcome === 'accepted' ? result.consistencyDelayMs : 0

const restrictMutationAuthority = (
  subject: string,
  reason: string,
): Effect.Effect<void, CycleRunnerError, AuthorityRestrictionStore | WriterFence> =>
  Effect.gen(function* () {
    const store = yield* AuthorityRestrictionStore
    const fence = yield* WriterFence
    const updatedAt = yield* currentUtcInstant
    yield* fence
      .transaction(store.restrictAuthority(`${subject} restricted effective authority: ${reason}`, updatedAt))
      .pipe(
        Effect.mapError((cause) =>
          mutationRunnerError(
            'authority restriction failed after a bound PAPER cycle failure',
            { subject, reason, cause },
            'store',
          ),
        ),
      )
  })

const restrictMutationLoopFailure = (
  error: CycleRunnerError,
): Effect.Effect<void, CycleRunnerError, AuthorityRestrictionStore | WriterFence> =>
  restrictMutationAuthority('PAPER autonomous cycle loop', `${error.operation}: ${error.message}`)

const executeMutationIntentWithExecutor = <E, R>(
  executor: PaperMutationExecutor<E, R>,
  intentId: string,
  action: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT',
  submitExpiresAt?: string,
): Effect.Effect<MutationIntentExecutionResult, CycleRunnerError, MutationStore | R> =>
  Effect.gen(function* () {
    const store = yield* MutationStore
    const operation = action === 'RECOVER_CANCEL' ? MutationOperation.Cancel : MutationOperation.Submit
    const existing = yield* store
      .latest(intentId, operation)
      .pipe(
        Effect.mapError((cause) =>
          mutationRunnerError(`durable ${operation.toLowerCase()} recovery read failed`, cause, 'store'),
        ),
      )
    let event: MutationEvent
    if (existing === undefined) {
      if (action !== 'SUBMIT') {
        return yield* Effect.fail(
          mutationRunnerError(
            `lookup-only PAPER recovery lost its durable ${operation.toLowerCase()} evidence`,
            { intentId, action, operation },
            'contract',
          ),
        )
      }
      if (submitExpiresAt === undefined) {
        return yield* Effect.fail(
          mutationRunnerError('fresh PAPER submit is missing its immutable submission cutoff', undefined, 'contract'),
        )
      }
      const submitObservedAt = yield* currentUtcInstant
      if (submitObservedAt >= submitExpiresAt) {
        return yield* Effect.fail(
          mutationRunnerError(
            'fresh PAPER submit crossed its immutable submission cutoff before broker I/O',
            { intentId, submitObservedAt, submitExpiresAt },
            'contract',
          ),
        )
      }
      if (executor.submit === undefined) {
        return yield* Effect.fail(
          mutationRunnerError(
            'fresh PAPER submit is unavailable under OBSERVE recovery-only authority',
            undefined,
            'contract',
          ),
        )
      }
      event = yield* executor
        .submit(intentId, mutationConsistencyDelayMs)
        .pipe(Effect.mapError((cause) => mutationRunnerError('guarded PAPER submit failed', cause)))
    } else if (operation === MutationOperation.Submit && submitDoesNotRequireRecovery(existing.eventType)) {
      event = existing
    } else {
      event = yield* executor
        .recover(intentId, operation)
        .pipe(
          Effect.mapError((cause) =>
            mutationRunnerError(`lookup-only PAPER ${operation.toLowerCase()} recovery failed`, cause),
          ),
        )
    }
    const settlement = decideMutationIntentSettlement(event.eventType)
    if (settlement._tag === 'Unresolved') {
      return yield* Effect.fail(
        mutationRunnerError(`guarded PAPER submit remains unresolved at ${settlement.eventType}`, event, 'operational'),
      )
    }
    return { settlement, consistencyDelayMs: event.consistencyDelayMs, operation }
  })

export const executeMutationIntent = (
  executionProgram: ExecutionProgram,
  intentId: string,
  action: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT',
  submitExpiresAt?: string,
): Effect.Effect<MutationIntentExecutionResult, CycleRunnerError, MutationStore> =>
  executeMutationIntentWithExecutor(
    {
      submit: executionProgram.submit,
      recover: executionProgram.recover,
    },
    intentId,
    action,
    submitExpiresAt,
  )

const executeBoundPaperCycle = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: PaperExecutionCapability,
): Effect.Effect<BoundMutationCycleOutcome, CycleRunnerError, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const step = yield* prepareNextMutationIntent(
      input,
      preparation,
      policy,
      cycle,
      document,
      reconcile,
      capability._tag === 'Mutation',
    )
    if (step._tag !== 'Execute') return step
    const executed = yield* capability._tag === 'Mutation'
      ? executeMutationIntent(
          capability.executionProgram,
          step.intentId,
          step.action,
          step.action === 'SUBMIT' ? step.submitExpiresAt : undefined,
        )
      : executeMutationIntentWithExecutor(
          { recover: recoverMutation },
          step.intentId,
          step.action,
          step.action === 'SUBMIT' ? step.submitExpiresAt : undefined,
        )
    if (executed.operation === MutationOperation.Submit && executed.settlement.outcome !== 'accepted') {
      yield* restrictMutationAuthority(
        `bound PAPER cycle ${cycle.identity.cycleId}`,
        `intent ${step.intentId} submit settled ${executed.settlement.outcome}`,
      )
    }
    const delayMs = mutationIntentReconciliationDelayMs(executed)
    if (delayMs > 0) yield* Effect.sleep(Duration.millis(delayMs))
    return { _tag: 'Wait' as const, observedAt: step.observedAt }
  })

const readUnfinishedMutationCycle = (
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<AutonomousCycle | undefined, CycleRunnerError, CycleStore> =>
  CycleStore.pipe(
    Effect.flatMap((store) =>
      store.readOldestUnfinished({
        qualificationRunId: context.qualificationRunId,
        accountId: context.accountId,
      }),
    ),
    Effect.mapError((cause) => mutationRunnerError('oldest unfinished mutation cycle read failed', cause, 'store')),
    Effect.map(Option.getOrUndefined),
  )

const mutationBound = (cycle: AutonomousCycle | undefined): cycle is AutonomousCycle =>
  cycle !== undefined && cycle.state === CycleState.Active && cycle.bindings.decisionHash !== undefined

const interpretBoundMutationCycleOutcome = (
  outcome: BoundMutationCycleOutcome,
  cycle: AutonomousCycle,
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore | ObserveDecisionRuntime> => {
  switch (outcome._tag) {
    case 'RunCycle':
      return runAutonomousCyclePass(context)
    case 'Wait':
      return Effect.succeed({
        outcome: 'RECOVERED',
        action: 'WAITING',
        observedAt: outcome.observedAt,
        cycle,
      })
    case 'Block':
      return CycleStore.pipe(
        Effect.flatMap((store) => store.block(cycle.identity.cycleId, outcome.reason, outcome.observedAt)),
        Effect.mapError((cause) => mutationRunnerError('expired PAPER cycle finalization failed', cause, 'store')),
        Effect.map((receipt) => ({
          outcome: 'RECOVERED' as const,
          action: 'BLOCKED' as const,
          observedAt: outcome.observedAt,
          cycle: receipt.cycle,
        })),
      )
    case 'Complete':
      return CycleStore.pipe(
        Effect.flatMap((store) => store.finish(cycle.identity.cycleId, CycleState.Completed, outcome.observedAt)),
        Effect.mapError((cause) => mutationRunnerError('completed PAPER cycle finalization failed', cause, 'store')),
        Effect.map((receipt) => ({
          outcome: 'RECOVERED' as const,
          action: 'COMPLETED' as const,
          observedAt: outcome.observedAt,
          cycle: receipt.cycle,
        })),
      )
  }
}

const recoverBoundMutationCycle = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  context: CycleRunContext<ObserveDecisionRuntime>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: PaperExecutionCapability,
): Effect.Effect<CycleRunResult, CycleRunnerError, RecoveryFirstRuntime> =>
  readBoundMutationDocument(cycle).pipe(
    Effect.flatMap((document) =>
      document.mode === 'OBSERVE'
        ? runAutonomousCyclePass(context)
        : executeBoundPaperCycle(input, preparation, policy, cycle, document, reconcile, capability).pipe(
            Effect.flatMap((outcome) => interpretBoundMutationCycleOutcome(outcome, cycle, context)),
          ),
    ),
  )

const runRecoveryFirstCyclePass = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  context: CycleRunContext<ObserveDecisionRuntime>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: PaperExecutionCapability,
): Effect.Effect<CycleRunResult, CycleRunnerError, RecoveryFirstRuntime> =>
  readUnfinishedMutationCycle(context).pipe(
    Effect.flatMap((unfinished) =>
      mutationBound(unfinished)
        ? recoverBoundMutationCycle(input, preparation, policy, unfinished, context, reconcile, capability)
        : runAutonomousCyclePass(context).pipe(
            Effect.flatMap((result) =>
              result.outcome === 'RECOVERED' && result.action === 'BOUND_DECISION'
                ? recoverBoundMutationCycle(input, preparation, policy, result.cycle, context, reconcile, capability)
                : Effect.succeed(result),
            ),
          ),
    ),
  )

const observeMutationPass = (
  startup: Parameters<AutonomousCycleStartup>[0],
  observation: CyclePassObservation,
): Effect.Effect<void> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return observePass(startup.recordPass, observation).pipe(
    Effect.andThen(log.pipe(Effect.annotateLogs(facts.annotations))),
  )
}

const mutationNanosPerMillisecond = 1_000_000n

const mutationIntervalNanos = (intervalMs: number): bigint => BigInt(intervalMs) * mutationNanosPerMillisecond

const mutationSleepUntil = (deadlineNanos: bigint): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((nowNanos) => {
      const remainingNanos = deadlineNanos - nowNanos
      if (remainingNanos <= 0n) return Effect.void
      const remainingMs = Number((remainingNanos + mutationNanosPerMillisecond - 1n) / mutationNanosPerMillisecond)
      return Effect.sleep(Duration.millis(remainingMs))
    }),
  )

const mutationIdleReconciliationError = (cause: ReconciliationPassError): CycleRunnerError => {
  const converted = notDueReconciliationError(cause)
  return new CycleRunnerError({
    operation: 'reconcile-not-due',
    failure: converted.failure,
    message: converted.message,
    cause: converted,
  })
}

const markMutationReconciliationCompleted = (cadence: Ref.Ref<ReconciliationCadenceState>): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })))

const attemptMutationIdleReconciliation = (
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<void, CycleRunnerError, ObserveDecisionRuntime> =>
  Clock.currentTimeNanos.pipe(
    Effect.tap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })),
    Effect.andThen(
      reconcile.pipe(
        Effect.asVoid,
        Effect.mapError(mutationIdleReconciliationError),
        Effect.tapError((lastFailure) =>
          Clock.currentTimeNanos.pipe(
            Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos, lastFailure })),
          ),
        ),
      ),
    ),
  )

const reconcileMutationNotDuePass = (
  input: ObserveAutonomousCycleInput,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult,
): Effect.Effect<CycleRunResult, CycleRunnerError, ObserveDecisionRuntime> => {
  if (result.outcome !== 'NOT_DUE') return Effect.succeed(result)
  return Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos
    const state = yield* Ref.get(cadence)
    const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
    if (decision._tag === 'WAIT') {
      if (state.lastFailure !== undefined) return yield* Effect.fail(state.lastFailure)
      return result
    }
    yield* attemptMutationIdleReconciliation(cadence, reconcile)
    return result
  })
}

const observeMutationIdleReconciliation = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: Extract<CycleRunResult, { readonly outcome: 'NOT_DUE' }>,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  reconcileMutationNotDuePass(input, cadence, reconcile, result).pipe(
    Effect.flatMap((reconciled) =>
      currentUtcInstant.pipe(
        Effect.flatMap((observedAt) =>
          observeMutationPass(startup, { outcome: 'SUCCEEDED', observedAt, result: reconciled }),
        ),
      ),
    ),
    Effect.catch((error) =>
      currentUtcInstant.pipe(
        Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
      ),
    ),
  )

const observeMutationCadenceReconciliation = (
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult | undefined,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Ref.get(cadence).pipe(
    Effect.flatMap((state) =>
      attemptMutationIdleReconciliation(cadence, reconcile).pipe(
        Effect.flatMap(() =>
          result !== undefined && (result.outcome === 'NOT_DUE' || state.lastFailure !== undefined)
            ? currentUtcInstant.pipe(
                Effect.flatMap((observedAt) =>
                  observeMutationPass(startup, { outcome: 'SUCCEEDED', observedAt, result }),
                ),
              )
            : Effect.void,
        ),
      ),
    ),
    Effect.catch((error) =>
      currentUtcInstant.pipe(
        Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
      ),
    ),
  )

const waitUntilNextMutationPoll = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult | undefined,
  nextPollAtNanos: bigint,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Effect.suspend(() =>
    Effect.gen(function* () {
      const nowNanos = yield* Clock.currentTimeNanos
      const state = yield* Ref.get(cadence)
      const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
      if (decision._tag === 'RECONCILE') {
        yield* observeMutationCadenceReconciliation(startup, cadence, reconcile, result)
        return yield* waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
      }
      const reconciliationAtNanos = nowNanos + decision.remainingNanos
      const pollStartAtNanos = nowNanos > nextPollAtNanos ? nowNanos : nextPollAtNanos
      const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
      if (
        shouldDeferCyclePollForReconciliation({
          lastAttemptAtNanos: state.lastAttemptAtNanos,
          nextPollAtNanos,
          pollStartAtNanos,
          reconciliationAtNanos,
          cyclePassTimeoutNanos: mutationIntervalNanos(cyclePassTimeoutMs),
        })
      ) {
        yield* mutationSleepUntil(reconciliationAtNanos)
        return yield* waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
      }
      if (nowNanos >= nextPollAtNanos) return
      if (nextPollAtNanos < reconciliationAtNanos) return yield* mutationSleepUntil(nextPollAtNanos)
      yield* mutationSleepUntil(reconciliationAtNanos)
      return yield* waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
    }),
  )

const waitAfterMutationPass = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((completedAtNanos) => {
      const nextPollAtNanos = completedAtNanos + mutationIntervalNanos(input.pollIntervalMs)
      return waitUntilNextMutationPoll(input, startup, cadence, reconcile, result, nextPollAtNanos)
    }),
  )

const waitAfterMutationFailure = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((completedAtNanos) =>
      waitUntilNextMutationPoll(
        input,
        startup,
        cadence,
        reconcile,
        undefined,
        completedAtNanos + mutationIntervalNanos(input.pollIntervalMs),
      ),
    ),
  )

const observeMutationCycleResult = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult,
): Effect.Effect<void, never, ObserveDecisionRuntime> =>
  result.outcome === 'NOT_DUE'
    ? observeMutationIdleReconciliation(input, startup, cadence, reconcile, result)
    : Ref.get(cadence).pipe(
        Effect.flatMap((state) =>
          currentUtcInstant.pipe(
            Effect.flatMap((observedAt) =>
              state.lastFailure === undefined
                ? observeMutationPass(startup, { outcome: 'SUCCEEDED', observedAt, result })
                : observeMutationPass(startup, { outcome: 'FAILED', observedAt, error: state.lastFailure }),
            ),
          ),
        ),
      )

const recoveryFirstCycleLoop = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: PaperExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
): Effect.Effect<void, never, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const cadence = yield* Ref.make<ReconciliationCadenceState>({})
    const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
    const reconcile = boundedReconciliationPass(input.reconciliationPassTimeoutMs).pipe(
      Effect.tap(() => markMutationReconciliationCompleted(cadence)),
    )
    const run = (): Effect.Effect<void, never, RecoveryFirstRuntime> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const context: CycleRunContext<ObserveDecisionRuntime> = {
            qualificationRunId: startup.qualificationRunId,
            strategyProtocolHash: preparation.strategyProtocolHash,
            accountId: input.accountId,
            executionPolicy: preparation.executionPolicy,
            buildDecision: (cycle) => buildDecision(cycle, reconcile),
          }
          return yield* runMutationPassWithinTimeout(
            runRecoveryFirstCyclePass(input, preparation, policy, context, reconcile, capability),
            cyclePassTimeoutMs,
          )
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              (capability._tag === 'Mutation' ? restrictMutationLoopFailure(error) : Effect.void).pipe(
                Effect.catch((restrictionError: CycleRunnerError) =>
                  currentUtcInstant.pipe(
                    Effect.flatMap((observedAt) =>
                      observeMutationPass(startup, { outcome: 'FAILED', observedAt, error: restrictionError }),
                    ),
                    Effect.andThen(Effect.die(restrictionError)),
                  ),
                ),
                Effect.andThen(currentUtcInstant),
                Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
                Effect.andThen(waitAfterMutationFailure(input, startup, cadence, reconcile)),
                Effect.andThen(run()),
              ),
            onSuccess: (result) =>
              observeMutationCycleResult(input, startup, cadence, reconcile, result).pipe(
                Effect.andThen(waitAfterMutationPass(input, startup, cadence, reconcile, result)),
                Effect.andThen(run()),
              ),
          }),
        ),
      )
    yield* run()
  })

const makeRecoveryFirstAutonomousLoop = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: PaperExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
  operation: 'autonomous cycle loop' | 'mutation autonomous cycle loop',
): Result.Result<AutonomousCycleLoop<RecoveryFirstRuntime>, OperationalError> => {
  const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
  return Result.mapError(
    Result.map(validateCycleLoopInterval(input.pollIntervalMs), () => input.reconciliationIntervalMs).pipe(
      Result.flatMap(validateReconciliationInterval),
      Result.flatMap(() => validateCyclePassTimeout(cyclePassTimeoutMs, input.reconciliationIntervalMs)),
      Result.map(() => recoveryFirstCycleLoop(input, startup, preparation, policy, capability, buildDecision)),
    ),
    (cause) => operationalError('strategy', 'cycle-loop', `${operation} failed to start`, cause),
  )
}

const observeDecisionBuilder =
  (
    input: ObserveAutonomousCycleInput,
    preparation: ObserveStartupPreparation,
    policy: Policy,
  ): RecoveryFirstDecisionBuilder =>
  (cycle, reconcile) =>
    buildObserveCycleDecision({
      authorityGenerationHash: input.authorityGenerationHash,
      cycle,
      executionModel: preparation.executionModel,
      policy,
      reconcile,
      strategy: input.strategy,
    }).pipe(Effect.mapError(decisionBuildError))

const mutationDecisionBuilder =
  (
    input: ObserveAutonomousCycleInput,
    preparation: ObserveStartupPreparation,
    policy: Policy,
  ): RecoveryFirstDecisionBuilder =>
  (cycle, reconcile) =>
    buildMutationShadowCycleDecision(mutationDecisionInput(input, preparation, policy, cycle, reconcile)).pipe(
      Effect.mapError(decisionBuildError),
    )

export const makeObserveAutonomousCycleStartup =
  (input: ObserveAutonomousCycleInput): AutonomousCycleStartup<AuthorityGenerationStore, RecoveryFirstRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      const policy = yield* loadObserveRiskPolicy(input.accountId, input.strategy.parameters.universe).pipe(
        Effect.mapError((cause) =>
          operationalError('strategy', 'risk-policy', 'source-controlled paper risk policy is invalid', cause),
        ),
      )
      yield* initializeObserveAuthority(input)
      return yield* Effect.fromResult(
        makeRecoveryFirstAutonomousLoop(
          input,
          startup,
          preparation,
          policy,
          { _tag: 'RecoveryOnly' },
          observeDecisionBuilder(input, preparation, policy),
          'autonomous cycle loop',
        ),
      )
    })

export const makeMutationAutonomousCycleStartup =
  (input: MutationAutonomousCycleInput): AutonomousCycleStartup<never, RecoveryFirstRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      yield* Effect.fromResult(validateMutationExecutionProgram(input))
      const policy = yield* loadObserveRiskPolicy(input.accountId, input.strategy.parameters.universe).pipe(
        Effect.mapError((cause) =>
          operationalError('strategy', 'risk-policy', 'source-controlled paper risk policy is invalid', cause),
        ),
      )
      return yield* Effect.fromResult(
        makeRecoveryFirstAutonomousLoop(
          input,
          startup,
          preparation,
          policy,
          { _tag: 'Mutation', executionProgram: input.executionProgram },
          mutationDecisionBuilder(input, preparation, policy),
          'mutation autonomous cycle loop',
        ),
      )
    })
