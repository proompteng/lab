import { Data, Duration, Effect, Result, Schema } from 'effect'
import type { AutonomousCycleStartup } from '../app'
import {
  BrokerRead,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
} from '../broker/alpaca'
import { quantizeAlpacaLimitPriceMicros } from '../broker/alpaca-price'
import { cycleAuthoritySessionDate, isIntradayAutonomousCycle, type AutonomousCycle } from '../cycle'
import { makeStrategyProtocolHashResult } from '../contracts'
import {
  CycleDecisionBuildError,
  CycleRunnerError,
  marketCalendarQueryFromSession,
  type CyclePassObservation,
} from '../cycle/runner'
import { retainAutonomousCyclePassObservation } from '../cycle/runner/pass-decisions'
import {
  bindCycleExecutionSession,
  type ExecutionSessionBinding,
  type ExecutionSessionBindingFailure,
} from '../execution-session'
import { OperationalError, operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  IntradaySnapshotFailure,
  IntradaySnapshotPurpose,
  persistIntradaySnapshotRows,
  type PersistedIntradaySnapshotRows,
} from '../market-data'
import {
  constrainExecutionTargetAllocationCapitalMicros,
  executionMandateAllocationCapitalMicros,
} from '../execution/mandate'
import { Authority, OrderType, TimeInForce, type AuthorityState, type Position } from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { isQuoteBoundExecutionModel, type CycleExecutionModel } from '../execution-model-contract'
import { legacyRiskPolicySchemaVersion, legacyRiskStateSchemaVersion } from '../execution/legacy-wire'
import { runOnce, type ReconciliationPassResult } from '../reconciler'
import { reconciledStateHash } from '../reconciliation'
import { BrokerMode, decodePolicy, executionRiskPolicySchemaVersion, type Policy, type State } from '../risk'
import {
  buildObserveShadowDecision,
  buildExecutionDecision,
  type ShadowDecisionError,
  type ShadowDeltaRiskInput,
} from '../shadow-decision'
import {
  ExecutionMarketDataBindingSchema,
  reconciledPositionLiquidationBindingSchemaVersion,
  type ExecutionMarketDataBinding,
  type CycleDecisionDocument,
  type ObserveShadowDecisionDocument,
  type ExecutionDecisionDocument,
} from '../shadow-decision-contract'
import { strictParseOptions } from '../schemas'
import { currentUtcInstant } from '../time'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import {
  planTargets,
  ExecutionReferencePricesSchema,
  intradaySnapshotReferencePricesSchemaVersion,
  quoteBoundTargetPlannerInputSchemaVersion,
  reconciledPositionReferencePricesSchemaVersion,
  type ExecutionReferencePrices,
  type IntradaySnapshotReferencePrices,
  type SignalSessionReferencePrices,
  type TargetPlannerInput,
  type TargetPlannerFailure,
  type TargetPlanResult,
} from '../target-planner'
import {
  decodeIntradayMomentumProtocol,
  makeIntradayMomentumDefinition,
  strategyDefinition,
  type IntradayMomentumStrategyDefinition,
  type StrategyRuntime,
} from '../strategy'
import type { RuntimeStrategyDecision } from '../strategy/runtime-decision'
import { defaultExecutionModel } from '../strategy/execution-model/model'
import type { DecisionPlan, IsoDate } from '../types'
import { mutationRunnerError } from './mutation-interpreter'
import {
  adverseClosingQuotePrices,
  executionMarketDataBinding,
  loadIntradaySnapshot,
  requireFreshIntradayPositionQuotes,
} from './intraday-market-data'
import {
  compileIntradayMomentumDecision,
  evaluateIntradayMomentumDecision,
  IntradayMomentumCloseAwaitingSnapshot,
  IntradayMomentumEntryAwaitingSnapshot,
  intradayMomentumCloseQuery,
  intradayMomentumEntryDisposition,
  intradayMomentumEntryQuery,
  intradayMomentumPricingQuery,
} from './intraday-momentum-decision'
import { Pipeable } from '../pipeable'
import type { ObserveAutonomousCycleInput, ObserveDecisionRuntime, ObserveStartupPreparation } from './model'

const dollarsToMicros = (dollars: bigint): string => (dollars * 1_000_000n).toString()

const observeRiskLimits = {
  maxOrderNotionalMicros: dollarsToMicros(40_000n),
  maxSymbolExposureMicros: dollarsToMicros(40_000n),
  maxGrossExposureMicros: dollarsToMicros(100_000n),
  maxNetExposureMicros: dollarsToMicros(100_000n),
  maxDailyTradedNotionalMicros: dollarsToMicros(200_000n),
  maxDailyLossMicros: dollarsToMicros(5_000n),
  maxDrawdownMicros: dollarsToMicros(5_000n),
  maxIntentAgeMs: 300_000,
  maxBrokerStateAgeMs: 300_000,
  maxMarketDataAgeMs: 300_000,
  maxAdverseSlippageBps: 10,
  decisionTtlMs: 300_000,
} as const

const loadExecutionRiskPolicyDataFirst = (
  accountId: string,
  allowedSymbols: readonly string[],
  executionModel: CycleExecutionModel,
) =>
  decodePolicy({
    schemaVersion: isQuoteBoundExecutionModel(executionModel)
      ? executionRiskPolicySchemaVersion
      : legacyRiskPolicySchemaVersion,
    accountId,
    brokerMode: BrokerMode.Execution,
    allowedSymbols: [...allowedSymbols].sort(),
    allowedOrderTypes: [isQuoteBoundExecutionModel(executionModel) ? OrderType.Limit : OrderType.Market],
    allowedTimeInForce: [isQuoteBoundExecutionModel(executionModel) ? TimeInForce.ImmediateOrCancel : TimeInForce.Day],
    maxOpenOrders: allowedSymbols.length,
    ...observeRiskLimits,
  })

export const loadExecutionRiskPolicy = Pipeable.dual(3, loadExecutionRiskPolicyDataFirst)

export const loadObserveRiskPolicy = (accountId: string, allowedSymbols: readonly string[]) =>
  loadExecutionRiskPolicyDataFirst(accountId, allowedSymbols, defaultExecutionModel)

const loadQuoteBoundExecutionRiskPolicyDataFirst = (accountId: string, allowedSymbols: readonly string[]) =>
  decodePolicy({
    schemaVersion: executionRiskPolicySchemaVersion,
    accountId,
    brokerMode: BrokerMode.Execution,
    allowedSymbols: [...allowedSymbols].sort(),
    allowedOrderTypes: [OrderType.Limit],
    allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
    maxOpenOrders: allowedSymbols.length,
    ...observeRiskLimits,
  })

export const loadQuoteBoundExecutionRiskPolicy = Pipeable.dual(2, loadQuoteBoundExecutionRiskPolicyDataFirst)

type ObserveStrategy = StrategyRuntime

class ReconciliationPassTimeoutError extends Data.TaggedError('ReconciliationPassTimeoutError')<{
  readonly timeoutMs: number
  readonly message: string
}> {}

export type ReconciliationPassError = Effect.Error<typeof runOnce> | ReconciliationPassTimeoutError

export const boundedReconciliationPass = (
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

export const mutationCyclePassTimeoutError = (timeoutMs: number): CycleRunnerError =>
  new CycleRunnerError({
    operation: 'run-cycle-pass',
    failure: 'operational',
    message: `mutation autonomous cycle pass did not complete or reconcile within ${timeoutMs.toString()}ms`,
  })

export const runMutationPassWithinTimeout = <A, E, R>(
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
  readonly executionModel: CycleExecutionModel
  readonly policy: Policy
  readonly reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, R>
  readonly strategy: ObserveStrategy
  readonly intradayMarketData?: import('../market-data').IntradayMarketDataService
  /** Worst-case delay required to run and durably bind one final decision before the submission cutoff. */
  readonly decisionFinalizationHeadroomMs?: number
}

export class ObserveDecisionAwaitingSignal extends Data.TaggedError('ObserveDecisionAwaitingSignal')<{
  readonly message: string
  readonly observedAt: string
  readonly submissionCutoffAt: string
}> {}

export class ExecutionCloseAwaitingMarketData extends Data.TaggedError('ExecutionCloseAwaitingMarketData')<{
  readonly message: string
  readonly observedAt: string
}> {}

type MarketCalendarRead = Effect.Success<ReturnType<BrokerReadShape['marketCalendar']>>
type CycleCalendarQueryFailure = Result.Result.Failure<ReturnType<typeof marketCalendarQueryFromSession>>

type ObserveDecisionCompositionFailure = {
  readonly _tag: 'ObserveDecisionCompositionFailure'
  readonly operation:
    | 'compiled-decision-hash'
    | 'cycle-binding'
    | 'observe-authority'
    | 'execution-mandate-allocation'
    | 'reconciled-state-hash'
    | 'reference-prices'
    | 'liquidation-binding'
    | 'risk-policy-hash'
    | 'shadow-risk-inputs'
    | 'strategy-execution-eligibility'
  readonly message: string
  readonly cause?: unknown
}

export type ObserveDecisionFailure =
  | CycleCalendarQueryFailure
  | ExecutionSessionBindingFailure
  | ObserveDecisionAwaitingSignal
  | ObserveDecisionCompositionFailure
  | OperationalError
  | ShadowDecisionError
  | TargetPlannerFailure

type ObserveDecisionReadPreparation = {
  readonly schemaVersion: 'bayn.observe-decision-read-preparation.v2'
  readonly marketCalendarQuery: MarketCalendarQuery
}

type ObserveDecisionCommonFacts = {
  readonly calendar: MarketCalendarRead
  readonly reconciliation: ReconciliationPassResult
  readonly evaluatedAt: string
}

type ObserveDecisionFacts = ObserveDecisionCommonFacts & {
  readonly schemaVersion: 'bayn.observe-decision-facts.v2'
}

type ObserveAuthorityObservation = {
  readonly authority: AuthorityState
  readonly observedAt: string
}

type ObservePlannerPreparation = {
  readonly plannerInput: TargetPlannerInput
  readonly prices: TargetPlannerInput['referencePrices']
}

type ObservePlannerOverrides = {
  readonly allocationCapitalMicros?: string
  readonly targetWeights?: DecisionPlan['targetWeights']
  readonly submissionCutoffAt?: string
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
      return operationalError({
        component: 'market-data',
        operation: 'reconciliation',
        message: 'same-pass broker reconciliation read failed',
        cause,
      })
    case 'ExecutionStoreError':
      return operationalError({
        component: 'database',
        operation: 'reconciliation',
        message: 'same-pass reconciliation store operation failed',
        cause,
      })
    case 'ReconciliationError':
      return operationalError({
        component: 'strategy',
        operation: 'reconciliation',
        message: 'same-pass reconciliation failed',
        cause,
      })
    case 'WriterFenceError':
      return operationalError({
        component: 'database',
        operation: 'reconciliation',
        message: 'same-pass reconciliation fence operation failed',
        cause,
      })
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

const operationalDecisionFailure = (
  component: OperationalError['component'],
): 'database' | 'market-data' | 'operational' => {
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

export const decisionBuildError = (cause: ObserveDecisionFailure): CycleDecisionBuildError => {
  switch (cause._tag) {
    case 'OperationalError':
      if (cause.cause instanceof IntradaySnapshotFailure && cause.cause.reason === 'not-ready') {
        return new CycleDecisionBuildError({ failure: 'not-ready', message: cause.message, cause })
      }
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
      return new CycleDecisionBuildError({ failure: 'contract', message: cause.message, cause })
    case 'ObserveDecisionAwaitingSignal':
      return new CycleDecisionBuildError({ failure: 'not-ready', message: cause.message, cause })
    case 'ObserveDecisionCompositionFailure':
    case 'ShadowDecisionError':
    case 'TargetPlannerFailure':
      return new CycleDecisionBuildError({ failure: 'contract', message: cause.message, cause })
  }
}

export const reconciliationRunnerError = (cause: ReconciliationPassError): CycleRunnerError => {
  const operational = reconciliationOperationalError(cause)
  return new CycleRunnerError({
    operation: 'reconcile',
    failure: operationalDecisionFailure(operational.component),
    message: operational.message,
    cause: operational,
  })
}

const hashObserveMaterial = (
  operation: Extract<
    ObserveDecisionCompositionFailure['operation'],
    'compiled-decision-hash' | 'reference-prices' | 'risk-policy-hash' | 'liquidation-binding'
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

interface IntradayQuotePriceMaps {
  readonly priceMicros: Readonly<Record<string, string>>
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly askPriceMicros: Readonly<Record<string, string>>
}

const intradayReferencePrices = (
  signalDate: SignalSessionReferencePrices['signalDate'],
  binding: NonNullable<CompiledObserveStrategyDecision['executionMarketData']>,
  prices: IntradayQuotePriceMaps,
): Result.Result<IntradaySnapshotReferencePrices, ObserveDecisionCompositionFailure> => {
  const material = {
    schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
    signalDate,
    observedAt: binding.observedAt,
    snapshotId: binding.snapshotId,
    snapshotContentHash: binding.contentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    priceMicros: prices.priceMicros,
    bidPriceMicros: prices.bidPriceMicros,
    askPriceMicros: prices.askPriceMicros,
  }
  return Result.map(
    hashObserveMaterial('reference-prices', 'Intraday snapshot reference prices are not canonicalizable', material),
    (contentHash) => ({ ...material, contentHash }),
  )
}

const decodeExecutionMarketDataBinding = Schema.decodeUnknownResult(
  ExecutionMarketDataBindingSchema,
  strictParseOptions,
)
const decodeExecutionReferencePrices = Schema.decodeUnknownResult(ExecutionReferencePricesSchema, strictParseOptions)

const reconciledPositionLiquidationBinding = (
  cycle: AutonomousCycle,
  calendar: MarketCalendarObservation,
  brokerState: ReconciliationPassResult['brokerState'],
  symbols: readonly string[],
): Result.Result<ExecutionMarketDataBinding, ObserveDecisionCompositionFailure> => {
  const selectedSymbols = new Set(symbols)
  const positions = brokerState.positions
    .filter(({ symbol, quantityMicros }) => selectedSymbols.has(symbol) && BigInt(quantityMicros) !== 0n)
    .toSorted((left, right) => left.symbol.localeCompare(right.symbol))
    .map(({ symbol, quantityMicros, marketPriceMicros, observedAt }) => ({
      symbol,
      quantityMicros,
      marketPriceMicros,
      observedAt,
    }))
  const material = {
    schemaVersion: reconciledPositionLiquidationBindingSchemaVersion,
    purpose: IntradaySnapshotPurpose.Liquidation,
    source: 'alpaca-v2-positions' as const,
    sessionDate: cycle.identity.executionSessionDate,
    calendar,
    observedAt: brokerState.positionsObservedAt,
    symbols: positions.map(({ symbol }) => symbol),
    positionsObservedAt: brokerState.positionsObservedAt,
    reconciliationId: brokerState.reconciliation.reconciliationId,
    reconciliationHash: brokerState.reconciliation.contentHash,
    positions,
  }
  return Result.flatMap(
    hashObserveMaterial(
      'liquidation-binding',
      'Reconciled broker positions are not canonicalizable as liquidation evidence',
      material,
    ),
    (contentHash) =>
      Result.flatMap(
        hashObserveMaterial(
          'liquidation-binding',
          'Reconciled broker position liquidation identity is not canonicalizable',
          { ...material, contentHash },
        ),
        (snapshotId) =>
          Result.mapError(decodeExecutionMarketDataBinding({ ...material, contentHash, snapshotId }), (cause) =>
            compositionFailure(
              'liquidation-binding',
              'Reconciled broker positions cannot form a liquidation binding',
              cause,
            ),
          ),
      ),
  )
}

const reconciledPositionReferencePrices = (
  signalDate: SignalSessionReferencePrices['signalDate'],
  binding: ExecutionMarketDataBinding,
): Result.Result<ExecutionReferencePrices, ObserveDecisionCompositionFailure> => {
  if (binding.schemaVersion !== reconciledPositionLiquidationBindingSchemaVersion) {
    return Result.fail(
      compositionFailure('reference-prices', 'Liquidation reference prices require reconciled broker positions'),
    )
  }
  const priceMicros = Object.fromEntries(
    binding.positions.map(({ symbol, quantityMicros, marketPriceMicros }) => [
      symbol,
      quantizeAlpacaLimitPriceMicros(BigInt(marketPriceMicros), BigInt(quantityMicros) < 0n ? 'UP' : 'DOWN').toString(),
    ]),
  )
  const material = {
    schemaVersion: reconciledPositionReferencePricesSchemaVersion,
    signalDate,
    observedAt: binding.observedAt,
    snapshotId: binding.snapshotId,
    snapshotContentHash: binding.contentHash,
    priceReference: 'reconciled-broker-position-mark' as const,
    priceMicros,
    bidPriceMicros: priceMicros,
    askPriceMicros: priceMicros,
  }
  return Result.flatMap(
    hashObserveMaterial('reference-prices', 'Reconciled position reference prices are not canonicalizable', material),
    (contentHash) =>
      Result.mapError(decodeExecutionReferencePrices({ ...material, contentHash }), (cause) =>
        compositionFailure('reference-prices', 'Reconciled position reference prices are invalid', cause),
      ),
  )
}

export const prepareObserveDecisionReads = <R>(
  input: ObserveDecisionInput<R>,
): Result.Result<ObserveDecisionReadPreparation, CycleCalendarQueryFailure | ObserveDecisionCompositionFailure> => {
  if (!isIntradayAutonomousCycle(input.cycle)) {
    return Result.fail(compositionFailure('cycle-binding', 'only current intraday cycles are executable'))
  }
  return Result.map(
    marketCalendarQueryFromSession(input.cycle.identity.executionSessionDate),
    (marketCalendarQuery) => ({
      schemaVersion: 'bayn.observe-decision-read-preparation.v2' as const,
      marketCalendarQuery,
    }),
  )
}

export const readObserveDecisionFacts = <R>(
  input: ObserveDecisionInput<R>,
  preparation: ObserveDecisionReadPreparation,
): Effect.Effect<ObserveDecisionFacts, OperationalError, BrokerRead | R> =>
  Effect.gen(function* () {
    const brokerRead = yield* BrokerRead
    const [calendar, reconciliation] = yield* Effect.all(
      [
        brokerRead.marketCalendar(preparation.marketCalendarQuery).pipe(
          Effect.mapError((cause) =>
            operationalError({
              component: 'market-data',
              operation: 'market-calendar',
              message: 'execution-session calendar read failed',
              cause,
            }),
          ),
        ),
        input.reconcile.pipe(Effect.mapError(reconciliationOperationalError)),
      ],
      { concurrency: 2 },
    )
    const evaluatedAt = yield* currentUtcInstant
    return {
      schemaVersion: 'bayn.observe-decision-facts.v2' as const,
      calendar,
      reconciliation,
      evaluatedAt,
    }
  })

type DecisionAuthorityRequirement = Authority.Observe | Authority.Execution

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

export const requireMutationAuthorityGeneration = (
  result: ReconciliationPassResult,
  policy: Policy,
  authorityGenerationHash: string,
): Result.Result<ObserveAuthorityObservation, ObserveDecisionCompositionFailure> => {
  const authority = result.riskContext.authority
  if (
    authority === null ||
    result.riskContext.authorityObservedAt === null ||
    authority.generationHash !== authorityGenerationHash ||
    authority.maximum !== Authority.Execution ||
    result.brokerState.account.accountId !== policy.accountId
  ) {
    return Result.fail(
      compositionFailure(
        'observe-authority',
        'same-pass reconciliation did not return the configured execution authority generation',
      ),
    )
  }
  return Result.succeed({ authority, observedAt: result.riskContext.authorityObservedAt })
}

const prepareExecutionSessionBinding = <R>(
  input: ObserveDecisionInput<R>,
  facts: ObserveDecisionFacts,
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure | ObserveDecisionCompositionFailure> => {
  if (facts.reconciliation.riskContext.tradingDate !== input.cycle.identity.executionSessionDate) {
    return Result.fail(
      compositionFailure(
        'cycle-binding',
        'same-pass reconciliation risk context is not from the execution session date',
      ),
    )
  }
  const stateHash = reconciledStateHash(facts.reconciliation.brokerState)
  if (Result.isFailure(stateHash)) {
    return Result.fail(
      compositionFailure(
        'reconciled-state-hash',
        'same-pass reconciled broker state is not canonicalizable',
        stateHash.failure,
      ),
    )
  }
  const common = {
    cycle: input.cycle,
    planningBrokerState: {
      observedAt: facts.reconciliation.brokerState.reconciliation.reconciledAt,
      contentHash: stateHash.success,
    },
    calendar: facts.calendar.value,
    executionModel: input.executionModel,
  }
  if (!isIntradayAutonomousCycle(input.cycle)) {
    return Result.fail(compositionFailure('cycle-binding', 'only current intraday cycles are executable'))
  }
  return bindCycleExecutionSession({
    ...common,
    executionSessionDate: input.cycle.identity.executionSessionDate,
  })
}

type CompiledObserveStrategyDecision = {
  readonly decision: RuntimeStrategyDecision
  readonly decisionMarketDataRows?: PersistedIntradaySnapshotRows
  /** Compatibility identity for the existing planner; intraday decisions remain bound separately to execution date. */
  readonly signalDate: SignalSessionReferencePrices['signalDate']
  readonly priceMicros: Readonly<Record<string, string>>
  readonly bidPriceMicros?: Readonly<Record<string, string>>
  readonly askPriceMicros?: Readonly<Record<string, string>>
  readonly maximumBuyQuantityMicros?: Readonly<Record<string, string>>
  readonly maximumSellQuantityMicros?: Readonly<Record<string, string>>
  readonly planningTargetWeights?: DecisionPlan['targetWeights']
  readonly decisionMarketData?: import('../shadow-decision-contract').ExecutionMarketDataBinding
  readonly executionMarketData?: import('../shadow-decision-contract').ExecutionMarketDataBinding
}

const intradayMomentumDefinition = (
  strategy: StrategyRuntime,
): Result.Result<IntradayMomentumStrategyDefinition, OperationalError> => {
  const definition = strategyDefinition(strategy)
  if (definition.name !== 'intraday-momentum' || definition.holdingPeriod !== 'INTRADAY') {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'current-decision',
        message: `strategy ${definition.name} is not the full-session intraday strategy`,
      }),
    )
  }
  return Result.mapError(
    Result.map(decodeIntradayMomentumProtocol(definition.parameters), makeIntradayMomentumDefinition),
    (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'current-decision',
        message: 'intraday-momentum runtime parameters are invalid',
        cause,
      }),
  )
}

const intradayArchiveMaterializationPending = (cause: unknown): cause is IntradaySnapshotFailure =>
  cause instanceof IntradaySnapshotFailure &&
  (cause.reason === 'not-ready' ||
    (cause.reason === 'watermark' &&
      cause.message === 'intraday archive has not materialized the captured source offset'))

const classifyIntradayEntrySnapshotFailure = (
  cause: OperationalError,
  observedAt: string,
  submissionCutoffAt: string,
): OperationalError | ObserveDecisionAwaitingSignal => {
  const snapshotFailure = cause.cause
  return intradayArchiveMaterializationPending(snapshotFailure)
    ? new ObserveDecisionAwaitingSignal({
        message: snapshotFailure.message,
        observedAt,
        submissionCutoffAt,
      })
    : cause
}

const compileObserveStrategyDecision = <R>(
  input: ObserveDecisionInput<R>,
  facts: ObserveDecisionFacts,
  executionSession: ExecutionSessionBinding,
): Effect.Effect<CompiledObserveStrategyDecision, OperationalError | ObserveDecisionAwaitingSignal> => {
  return Effect.gen(function* () {
    const intradayMarketData = input.intradayMarketData
    if (intradayMarketData === undefined) {
      return yield* operationalError({
        component: 'market-data',
        operation: 'current-decision',
        message: 'intraday-momentum runtime has no injected intraday archive reader',
      })
    }
    const intradayDefinition = yield* Effect.fromResult(intradayMomentumDefinition(input.strategy))
    const heldPositions = facts.reconciliation.brokerState.positions.filter(
      (position) => BigInt(position.quantityMicros) !== 0n,
    )
    const strategyUniverse = new Set(intradayDefinition.parameters.universe)
    const planningHeldPositions = heldPositions.filter((position) => strategyUniverse.has(position.symbol))
    const heldSymbols = planningHeldPositions.map((position) => position.symbol)
    const decisionQuery = yield* Effect.fromResult(
      intradayMomentumEntryQuery(
        input.cycle,
        intradayDefinition.parameters,
        executionSession.calendar,
        facts.evaluatedAt,
      ),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof IntradayMomentumEntryAwaitingSnapshot
          ? new ObserveDecisionAwaitingSignal({
              message: cause.message,
              observedAt: facts.evaluatedAt,
              submissionCutoffAt: input.cycle.window.submissionCutoffAt,
            })
          : operationalError({
              component: 'market-data',
              operation: 'current-decision',
              message: cause.message,
              cause,
            }),
      ),
    )
    const decisionSnapshot = yield* loadIntradaySnapshot(intradayMarketData, decisionQuery).pipe(
      Effect.mapError((cause) =>
        classifyIntradayEntrySnapshotFailure(cause, facts.evaluatedAt, input.cycle.window.submissionCutoffAt),
      ),
    )
    const decision = yield* Effect.fromResult(
      evaluateIntradayMomentumDecision(intradayDefinition, input.cycle, decisionSnapshot),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof IntradayMomentumEntryAwaitingSnapshot
          ? new ObserveDecisionAwaitingSignal({
              message: cause.message,
              observedAt: facts.evaluatedAt,
              submissionCutoffAt: input.cycle.window.submissionCutoffAt,
            })
          : operationalError({
              component: 'strategy',
              operation: 'current-decision',
              message: cause.message,
              cause,
            }),
      ),
    )
    const pricingSymbols = [...new Set([...Object.keys(decision.targetWeights), ...heldSymbols])].sort()
    const pricingSnapshot =
      pricingSymbols.length === 0
        ? decisionSnapshot
        : yield* Effect.gen(function* () {
            const pricingQuery = yield* Effect.fromResult(
              intradayMomentumPricingQuery(
                input.cycle,
                intradayDefinition.parameters,
                executionSession.calendar,
                facts.evaluatedAt,
                decisionSnapshot.manifest.rangeEndAt,
                pricingSymbols,
              ),
            ).pipe(
              Effect.mapError((cause) =>
                operationalError({
                  component: 'market-data',
                  operation: 'current-decision',
                  message: cause.message,
                  cause,
                }),
              ),
            )
            return yield* loadIntradaySnapshot(intradayMarketData, pricingQuery).pipe(
              Effect.mapError((cause) =>
                classifyIntradayEntrySnapshotFailure(cause, facts.evaluatedAt, input.cycle.window.submissionCutoffAt),
              ),
            )
          })
    const compiled = yield* Effect.fromResult(
      Result.flatMap(
        requireFreshIntradayPositionQuotes(pricingSnapshot, facts.reconciliation.brokerState.positions),
        () => compileIntradayMomentumDecision(decision, decisionSnapshot, pricingSnapshot, planningHeldPositions),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        operationalError({
          component: 'strategy',
          operation: 'current-decision',
          message: cause.message,
          cause,
        }),
      ),
    )
    if (
      input.decisionFinalizationHeadroomMs !== undefined &&
      intradayMomentumEntryDisposition(
        compiled.decision,
        heldPositions.length > 0,
        input.cycle.window.submissionCutoffAt,
        input.decisionFinalizationHeadroomMs,
      ) === 'AWAIT_SIGNAL'
    ) {
      return yield* new ObserveDecisionAwaitingSignal({
        message: 'full-session intraday entry remains armed while a qualifying signal can still arrive',
        observedAt: facts.evaluatedAt,
        submissionCutoffAt: input.cycle.window.submissionCutoffAt,
      })
    }
    return { ...compiled, signalDate: cycleAuthoritySessionDate(input.cycle.identity) }
  })
}

export const prepareObservePlanner = <R>(
  input: ObserveDecisionInput<R>,
  facts: Pick<ObserveDecisionFacts, 'reconciliation' | 'evaluatedAt'>,
  compiled: CompiledObserveStrategyDecision,
  overrides: ObservePlannerOverrides = {},
): Result.Result<ObservePlannerPreparation, ObserveDecisionCompositionFailure> =>
  Result.flatMap(referencePrices(compiled.signalDate, facts.evaluatedAt, compiled.priceMicros), (prices) =>
    Result.flatMap(
      hashObserveMaterial('risk-policy-hash', 'OBSERVE risk policy is not canonicalizable', input.policy),
      (policyHash) =>
        Result.flatMap(
          hashObserveMaterial(
            'compiled-decision-hash',
            'current strategy decision is not canonicalizable',
            compiled.decision,
          ),
          (decisionHash): Result.Result<ObservePlannerPreparation, ObserveDecisionCompositionFailure> => {
            if (!isQuoteBoundExecutionModel(input.executionModel)) {
              return Result.fail(compositionFailure('cycle-binding', 'intraday runtime requires quote-bound execution'))
            }
            if (
              compiled.executionMarketData === undefined ||
              compiled.bidPriceMicros === undefined ||
              compiled.askPriceMicros === undefined ||
              compiled.maximumBuyQuantityMicros === undefined ||
              compiled.maximumSellQuantityMicros === undefined ||
              overrides.allocationCapitalMicros === undefined
            ) {
              return Result.fail(
                compositionFailure(
                  'cycle-binding',
                  'quote-bound intraday planning requires exact market-data and allocation bindings',
                ),
              )
            }
            const commonPlannerInput = {
              strategyName: input.cycle.identity.strategyName,
              cycleId: input.cycle.identity.cycleId,
              decisionHash,
              policyHash,
              accountId: input.cycle.identity.accountId,
              signalDate: compiled.signalDate,
              targetWeights:
                overrides.targetWeights ?? compiled.planningTargetWeights ?? compiled.decision.targetWeights,
              referencePrices: prices,
              brokerState: facts.reconciliation.brokerState,
              precision: input.executionModel.precision,
              maximumInputAgeMs: Math.min(input.policy.maxBrokerStateAgeMs, input.policy.maxMarketDataAgeMs),
              submissionCutoffAt: overrides.submissionCutoffAt ?? input.cycle.window.submissionCutoffAt,
              observedAt: facts.evaluatedAt,
            }
            const boundPrices = intradayReferencePrices(compiled.signalDate, compiled.executionMarketData, {
              priceMicros: compiled.priceMicros,
              bidPriceMicros: compiled.bidPriceMicros,
              askPriceMicros: compiled.askPriceMicros,
            })
            if (Result.isFailure(boundPrices)) return Result.fail(boundPrices.failure)
            const plannerInput: TargetPlannerInput = {
              schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
              ...commonPlannerInput,
              referencePrices: boundPrices.success,
              precision: {
                quantityIncrementMicros: '1000000',
                priceIncrementMicros: input.executionModel.precision.priceIncrementMicros,
                minimumBuyNotionalMicros: input.executionModel.precision.minimumBuyNotionalMicros,
              },
              allocationCapitalMicros: overrides.allocationCapitalMicros,
              executionTerms: {
                orderType: OrderType.Limit,
                timeInForce: TimeInForce.ImmediateOrCancel,
                priceReference: 'verified-adverse-quote-boundary' as const,
                snapshotId: compiled.executionMarketData.snapshotId,
                snapshotContentHash: compiled.executionMarketData.contentHash,
                maximumBuyQuantityMicros: compiled.maximumBuyQuantityMicros,
                maximumSellQuantityMicros: compiled.maximumSellQuantityMicros,
              },
            }
            return Result.succeed({
              prices: boundPrices.success,
              plannerInput,
            })
          },
        ),
    ),
  )

type RiskInputPreparation = {
  readonly executionModel: CycleExecutionModel
  readonly reconciliation: ReconciliationPassResult
  readonly authorityObservation: ObserveAuthorityObservation
  readonly executionSession: ExecutionSessionBinding
  readonly targetPlan: TargetPlanResult
  readonly snapshotContentHash: string
  readonly executionMarketData?: Pick<
    import('../shadow-decision-contract').ExecutionMarketDataBinding,
    'contentHash' | 'observedAt'
  >
  readonly evaluatedAt: string
  readonly closeOnlyExpiresAt?: string
}

const reduceRiskInputs = (
  input: RiskInputPreparation,
): Result.Result<readonly ShadowDeltaRiskInput[], ObserveDecisionCompositionFailure> =>
  Result.mapError(
    Result.all(
      input.targetPlan.intentTargets.map((target) => {
        const referencePriceMicros = input.targetPlan.targets.find(
          (planned) => planned.symbol === target.symbol,
        )?.referencePriceMicros
        if (referencePriceMicros === undefined) {
          return Result.fail(
            compositionFailure(
              'shadow-risk-inputs',
              `target ${target.symbol} has no bound signal-session reference price`,
            ),
          )
        }
        const referencePrice = BigInt(referencePriceMicros)
        return Result.map(
          deriveExecutionIntentPricing({
            side: target.side,
            orderType: target.orderType,
            timeInForce: target.timeInForce,
            quantityMicros: BigInt(target.quantityMicros),
            referencePriceMicros: referencePrice,
            executionModel: input.executionModel,
          }),
          (pricing): ShadowDeltaRiskInput => {
            const state: State = {
              schemaVersion: legacyRiskStateSchemaVersion,
              brokerMode: BrokerMode.Execution,
              account: input.reconciliation.brokerState.account,
              positions: input.reconciliation.brokerState.positions,
              positionsObservedAt: input.reconciliation.brokerState.positionsObservedAt,
              orders: input.reconciliation.brokerState.orders,
              ordersObservedAt: input.reconciliation.brokerState.ordersObservedAt,
              reconciliation: input.reconciliation.brokerState.reconciliation,
              authority: input.authorityObservation.authority,
              authorityObservedAt: input.authorityObservation.observedAt,
              unknownMutationCount: input.reconciliation.riskContext.unknownMutationCount,
              dailyTradedNotionalMicros: input.reconciliation.riskContext.dailyTradedNotionalMicros,
              dayStartEquityMicros: input.reconciliation.riskContext.dayStartEquityMicros,
              peakEquityMicros: input.reconciliation.riskContext.peakEquityMicros,
              accountingHash: input.reconciliation.brokerState.accountingHash,
              marketDataSymbol: target.symbol,
              marketDataHash: input.executionMarketData?.contentHash ?? input.snapshotContentHash,
              ...(input.executionMarketData === undefined
                ? {}
                : { executionMarketDataHash: input.executionMarketData.contentHash }),
              referencePriceMicros: referencePrice.toString(),
              expectedExecutionPriceMicros: pricing.expectedExecutionPriceMicros.toString(),
              marketDataObservedAt: input.executionMarketData?.observedAt ?? input.evaluatedAt,
              executionSession: input.executionSession,
              reservedBuyingPowerMicros: '0',
              evaluatedAt: input.evaluatedAt,
              ...(input.closeOnlyExpiresAt === undefined
                ? {}
                : { closeOnly: true as const, closeOnlyExpiresAt: input.closeOnlyExpiresAt }),
            }
            return {
              symbol: target.symbol,
              notionalLimitMicros: pricing.notionalLimitMicros.toString(),
              state,
            }
          },
        )
      }),
    ),
    (cause) => compositionFailure('shadow-risk-inputs', 'shadow risk input construction failed', cause),
  )

const reduceObserveRiskInputs = <R>(
  input: ObserveDecisionInput<R>,
  facts: ObserveDecisionFacts,
  authorityObservation: ObserveAuthorityObservation,
  executionSession: ExecutionSessionBinding,
  targetPlan: TargetPlanResult,
  snapshotContentHash: string,
  executionMarketData?: Pick<
    import('../shadow-decision-contract').ExecutionMarketDataBinding,
    'contentHash' | 'observedAt'
  >,
  closeOnlyExpiresAt?: string,
): Result.Result<readonly ShadowDeltaRiskInput[], ObserveDecisionCompositionFailure> =>
  reduceRiskInputs({
    executionModel: input.executionModel,
    reconciliation: facts.reconciliation,
    authorityObservation,
    executionSession,
    targetPlan,
    snapshotContentHash,
    ...(executionMarketData === undefined ? {} : { executionMarketData }),
    evaluatedAt: facts.evaluatedAt,
    ...(closeOnlyExpiresAt === undefined ? {} : { closeOnlyExpiresAt }),
  })

export const buildObserveCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
): Effect.Effect<ObserveShadowDecisionDocument, ObserveDecisionFailure, BrokerRead | R> =>
  buildCycleDecision(input, { authorityRequirement: Authority.Observe, documentMode: Authority.Observe })

type CycleDecisionRequirements =
  | { readonly authorityRequirement: Authority.Observe; readonly documentMode: Authority.Observe }
  | { readonly authorityRequirement: Authority.Execution; readonly documentMode: Authority.Execution }

function buildCycleDecision<R>(
  input: ObserveDecisionInput<R>,
  requirements: { readonly authorityRequirement: Authority.Observe; readonly documentMode: Authority.Observe },
): Effect.Effect<ObserveShadowDecisionDocument, ObserveDecisionFailure, BrokerRead | R>
function buildCycleDecision<R>(
  input: ObserveDecisionInput<R>,
  requirements: { readonly authorityRequirement: Authority.Execution; readonly documentMode: Authority.Execution },
): Effect.Effect<ExecutionDecisionDocument, ObserveDecisionFailure, BrokerRead | R>
function buildCycleDecision<R>(
  input: ObserveDecisionInput<R>,
  requirements: CycleDecisionRequirements,
): Effect.Effect<CycleDecisionDocument, ObserveDecisionFailure, BrokerRead | R> {
  return Effect.gen(function* () {
    const readPreparation = yield* Effect.fromResult(prepareObserveDecisionReads(input))
    const facts = yield* readObserveDecisionFacts(input, readPreparation)
    const executionAuthority = yield* Effect.fromResult(
      requireDecisionAuthority(
        facts.reconciliation,
        input.policy,
        input.authorityGenerationHash,
        requirements.authorityRequirement,
      ),
    )
    const executionSession = yield* Effect.fromResult(prepareExecutionSessionBinding(input, facts))
    const compiled = yield* compileObserveStrategyDecision(input, facts, executionSession)
    const planningTargetWeights = compiled.planningTargetWeights ?? compiled.decision.targetWeights
    const allowedSymbols = new Set(input.policy.allowedSymbols)
    const hasExternalPosition = facts.reconciliation.brokerState.positions.some(
      ({ symbol, quantityMicros }) => BigInt(quantityMicros) !== 0n && !allowedSymbols.has(symbol),
    )
    let allocationCapitalMicros: bigint | undefined
    if (requirements.authorityRequirement === Authority.Execution) {
      allocationCapitalMicros = hasExternalPosition
        ? 0n
        : yield* Effect.fromResult(
            Result.flatMap(
              executionMandateAllocationCapitalMicros({
                accountEquityMicros: BigInt(facts.reconciliation.brokerState.account.equityMicros),
                dailyTradedNotionalMicros: BigInt(facts.reconciliation.riskContext.dailyTradedNotionalMicros),
                maxGrossExposureMicros: BigInt(input.policy.maxGrossExposureMicros),
                maxNetExposureMicros: BigInt(input.policy.maxNetExposureMicros),
                maxDailyTradedNotionalMicros: BigInt(input.policy.maxDailyTradedNotionalMicros),
                maxAdverseSlippageBps: BigInt(input.policy.maxAdverseSlippageBps),
                positions: facts.reconciliation.brokerState.positions,
                referencePriceMicros: compiled.priceMicros,
              }),
              (capitalMicros) =>
                isQuoteBoundExecutionModel(input.executionModel)
                  ? constrainExecutionTargetAllocationCapitalMicros({
                      allocationCapitalMicros: capitalMicros,
                      maxOrderNotionalMicros: BigInt(input.policy.maxOrderNotionalMicros),
                      maxSymbolExposureMicros: BigInt(input.policy.maxSymbolExposureMicros),
                      targetWeights: planningTargetWeights,
                    })
                  : Result.succeed(capitalMicros),
            ),
          ).pipe(
            Effect.mapError((cause) =>
              compositionFailure(
                'execution-mandate-allocation',
                'execution entry cannot fit its complete sell-plus-buy plan inside the remaining turnover budget',
                cause,
              ),
            ),
          )
    } else if (isQuoteBoundExecutionModel(input.executionModel)) {
      allocationCapitalMicros = BigInt(facts.reconciliation.brokerState.account.equityMicros)
    }
    const plannerPreparation = yield* Effect.fromResult(
      prepareObservePlanner(input, facts, compiled, {
        targetWeights: planningTargetWeights,
        ...(allocationCapitalMicros === undefined
          ? {}
          : { allocationCapitalMicros: allocationCapitalMicros.toString() }),
      }),
    )
    const targetPlan = yield* Effect.fromResult(planTargets(plannerPreparation.plannerInput))
    const snapshotContentHash = compiled.executionMarketData?.contentHash
    if (snapshotContentHash === undefined) {
      return yield* Effect.fail(
        compositionFailure('cycle-binding', 'decision has no immutable market-data snapshot binding'),
      )
    }
    const riskInputs = yield* Effect.fromResult(
      reduceObserveRiskInputs(
        input,
        facts,
        executionAuthority,
        executionSession,
        targetPlan,
        snapshotContentHash,
        compiled.executionMarketData,
      ),
    )
    const decisionMarketData = compiled.decisionMarketData ?? compiled.executionMarketData
    const decisionSnapshot =
      decisionMarketData === undefined
        ? undefined
        : {
            snapshotId: decisionMarketData.snapshotId,
            contentHash: decisionMarketData.contentHash,
            finalizedAt: decisionMarketData.observedAt,
          }
    if (decisionSnapshot === undefined) {
      return yield* Effect.fail(
        compositionFailure('cycle-binding', 'decision has no immutable market-data snapshot binding'),
      )
    }
    const decisionInput = {
      cycle: input.cycle,
      snapshot: {
        snapshotId: decisionSnapshot.snapshotId,
        contentHash: decisionSnapshot.contentHash,
        finalizedAt: decisionSnapshot.finalizedAt,
      },
      compiledDecision: compiled.decision,
      ...(compiled.decisionMarketDataRows === undefined
        ? {}
        : { decisionMarketDataRows: compiled.decisionMarketDataRows }),
      ...(compiled.decisionMarketData === undefined ? {} : { decisionMarketData: compiled.decisionMarketData }),
      ...(compiled.executionMarketData === undefined ? {} : { executionMarketData: compiled.executionMarketData }),
      plannerInput: plannerPreparation.plannerInput,
      targetPlan,
      policy: input.policy,
      riskInputs,
    }
    return requirements.documentMode === Authority.Observe
      ? yield* buildObserveShadowDecision(decisionInput)
      : yield* buildExecutionDecision({
          ...decisionInput,
          authorityGenerationHash: input.authorityGenerationHash,
          executionSession,
        })
  })
}

export const buildMutationShadowCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
): Effect.Effect<ExecutionDecisionDocument, ObserveDecisionFailure, BrokerRead | R> =>
  buildCycleDecision(input, { authorityRequirement: Authority.Execution, documentMode: Authority.Execution })

export const makeClosingDecisionPlan = (
  identity: {
    readonly strategyName: string
    readonly executionSessionDate: IsoDate
  },
  symbols: readonly string[],
): Result.Result<RuntimeStrategyDecision, ObserveDecisionCompositionFailure> => {
  const orderedSymbols = [...new Set(symbols)].sort()
  if (identity.strategyName !== 'intraday-momentum') {
    return Result.fail(
      compositionFailure('cycle-binding', 'only the active intraday strategy can build close decisions'),
    )
  }
  return Result.succeed({
    schemaVersion: 'bayn.execution-flat-target.v1',
    strategyName: identity.strategyName,
    sessionDate: identity.executionSessionDate,
    targetWeights: Object.fromEntries(orderedSymbols.map((symbol) => [symbol, 0])),
    symbols: orderedSymbols,
    reason: 'mandate-close',
  })
}

const recoverExecutionSession = (
  executionModel: CycleExecutionModel,
  cycle: AutonomousCycle,
  entryDocument: ExecutionDecisionDocument,
): Result.Result<ExecutionSessionBinding, ObserveDecisionCompositionFailure> => {
  const bindRecoveredSession = (input: Parameters<typeof bindCycleExecutionSession>[0]) =>
    Result.mapError(bindCycleExecutionSession(input), (cause) =>
      compositionFailure('cycle-binding', 'execution-session binding does not match its cycle', cause),
    )
  const persistedSession = entryDocument.executionSession
  if (
    persistedSession === undefined ||
    persistedSession.schemaVersion !== 'bayn.execution-session-binding.v3' ||
    !isIntradayAutonomousCycle(cycle)
  ) {
    return Result.fail(
      compositionFailure('cycle-binding', 'intraday close requires its persisted v3 execution-session binding'),
    )
  }
  return bindRecoveredSession({
    cycle,
    executionSessionDate: persistedSession.executionSession.date,
    planningBrokerState: persistedSession.planningBrokerState,
    calendar: persistedSession.calendar,
    executionModel,
  })
}

export type ClosingSymbolPass = {
  readonly kind: 'broker-position' | 'fractional' | 'quote-bound'
  readonly symbols: readonly string[]
}

export const selectClosingSymbolPass = (
  positions: readonly Pick<Position, 'symbol' | 'quantityMicros'>[],
  universe: readonly string[],
): ClosingSymbolPass => {
  const activePositions = positions
    .filter(({ quantityMicros }) => BigInt(quantityMicros) !== 0n)
    .toSorted((left, right) => left.symbol.localeCompare(right.symbol))

  const allowedSymbols = new Set(universe)
  const externalSymbols = activePositions
    .filter(({ symbol }) => !allowedSymbols.has(symbol))
    .map(({ symbol }) => symbol)
  if (externalSymbols.length > 0) return { kind: 'broker-position', symbols: externalSymbols }

  const fractionalSymbols = activePositions
    .filter(({ quantityMicros }) => BigInt(quantityMicros) % 1_000_000n !== 0n)
    .map(({ symbol }) => symbol)
  return fractionalSymbols.length > 0
    ? { kind: 'fractional', symbols: fractionalSymbols }
    : { kind: 'quote-bound', symbols: activePositions.map(({ symbol }) => symbol) }
}

export interface BuildClosingExecutionCycleDecisionInput {
  readonly input: ObserveAutonomousCycleInput
  readonly preparation: ObserveStartupPreparation
  readonly policy: Policy
  readonly cycle: AutonomousCycle
  readonly entryDocument: ExecutionDecisionDocument
  readonly reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>
  readonly closeExpiresAt: string
  readonly replanGenerationHash?: string
}

export const buildClosingExecutionCycleDecision = (
  request: BuildClosingExecutionCycleDecisionInput,
): Effect.Effect<
  ExecutionDecisionDocument,
  CycleRunnerError | ExecutionCloseAwaitingMarketData,
  ObserveDecisionRuntime
> => {
  const { input, preparation, policy, cycle, entryDocument, reconcile, closeExpiresAt, replanGenerationHash } = request
  return Effect.gen(function* () {
    const executionModel = preparation.executionModel
    if (executionModel.schemaVersion !== 'bayn.execution-model.v5' || !isIntradayAutonomousCycle(cycle)) {
      return yield* mutationRunnerError({
        message: 'execution close requires the active intraday execution contract',
        failure: 'contract',
      })
    }
    const reconciliation = yield* reconcile.pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: 'execution close reconciliation failed', cause })),
    )
    const evaluatedAt = yield* currentUtcInstant
    const executionAuthority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(reconciliation, policy, input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const executionSession = yield* Effect.fromResult(
      recoverExecutionSession(executionModel, cycle, entryDocument),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const runtimeProtocolHash = makeStrategyProtocolHashResult(input.strategy.provenance.strategy)
    const runtimeMatchesCycle =
      Result.isSuccess(runtimeProtocolHash) &&
      runtimeProtocolHash.success === cycle.identity.strategyProtocolHash &&
      strategyDefinition(input.strategy).name === cycle.identity.strategyName
    if (!runtimeMatchesCycle) {
      return yield* mutationRunnerError({
        message: 'execution close does not match the active intraday strategy identity',
        failure: 'contract',
      })
    }
    const intradayParameters = yield* Effect.fromResult(intradayMomentumDefinition(input.strategy)).pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })),
      Effect.map((definition) => definition.parameters),
    )
    const entryMarketData = entryDocument.bindings.executionMarketData
    const persistedUniverse =
      entryMarketData?.schemaVersion === 'bayn.execution-market-data-binding.v2' ? entryMarketData.universe : undefined
    const closingPass = selectClosingSymbolPass(
      reconciliation.brokerState.positions,
      persistedUniverse ?? intradayParameters.universe,
    )
    const symbols = closingPass.symbols
    const requiresFractionalClose = closingPass.kind === 'fractional'
    const closeDecision = yield* Effect.fromResult(makeClosingDecisionPlan(cycle.identity, symbols)).pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })),
    )
    const closeDecisionHash = yield* Effect.fromResult(
      hashObserveMaterial('compiled-decision-hash', 'close decision is not canonicalizable', closeDecision),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const positionQuantities = new Map(
      reconciliation.brokerState.positions.map((position) => [position.symbol, BigInt(position.quantityMicros)]),
    )
    const maximumCloseBuyQuantityMicros = Object.fromEntries(
      Object.keys(closeDecision.targetWeights)
        .sort()
        .map((symbol) => {
          const currentQuantity = positionQuantities.get(symbol) ?? 0n
          return [symbol, currentQuantity < 0n ? String(-currentQuantity) : '0']
        }),
    )
    const maximumCloseSellQuantityMicros = Object.fromEntries(
      Object.keys(closeDecision.targetWeights)
        .sort()
        .map((symbol) => {
          const currentQuantity = positionQuantities.get(symbol) ?? 0n
          return [symbol, currentQuantity > 0n ? String(currentQuantity) : '0']
        }),
    )
    const closeExecutionMarketData = yield* Effect.gen(function* () {
      if (closingPass.kind === 'broker-position') {
        const binding = yield* Effect.fromResult(
          reconciledPositionLiquidationBinding(cycle, executionSession.calendar, reconciliation.brokerState, symbols),
        ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
        const referencePrices = yield* Effect.fromResult(
          reconciledPositionReferencePrices(cycle.identity.executionSessionDate, binding),
        ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
        return {
          binding,
          bidPriceMicros: referencePrices.bidPriceMicros,
          askPriceMicros: referencePrices.askPriceMicros,
          decisionMarketDataRows: undefined,
        }
      }
      if (symbols.some((symbol) => !intradayParameters.universe.includes(symbol))) {
        return yield* mutationRunnerError({
          message: 'intraday close contains a position outside the active strategy universe',
          failure: 'contract',
        })
      }
      if (input.intradayMarketData === undefined) {
        return yield* mutationRunnerError({
          message: 'intraday close has no injected intraday archive reader',
          failure: 'operational',
        })
      }
      const query = yield* Effect.fromResult(
        intradayMomentumCloseQuery(cycle, intradayParameters, executionSession.calendar, evaluatedAt, symbols),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof IntradayMomentumCloseAwaitingSnapshot
            ? new ExecutionCloseAwaitingMarketData({ message: cause.message, observedAt: evaluatedAt })
            : mutationRunnerError({ message: cause.message, cause, failure: 'contract' }),
        ),
      )
      const snapshot = yield* loadIntradaySnapshot(input.intradayMarketData, query).pipe(
        Effect.mapError((cause) =>
          intradayArchiveMaterializationPending(cause.cause)
            ? new ExecutionCloseAwaitingMarketData({ message: cause.message, observedAt: evaluatedAt })
            : mutationRunnerError({ message: 'execution close market-data read failed', cause }),
        ),
      )
      const quotePrices = yield* Effect.fromResult(adverseClosingQuotePrices(snapshot, symbols)).pipe(
        Effect.mapError((cause) =>
          cause.operation === 'close-quote-not-ready'
            ? new ExecutionCloseAwaitingMarketData({ message: cause.message, observedAt: evaluatedAt })
            : mutationRunnerError({ message: cause.message, cause, failure: 'contract' }),
        ),
      )
      const binding = yield* Effect.fromResult(executionMarketDataBinding(snapshot)).pipe(
        Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })),
      )
      const decisionMarketDataRows = yield* Effect.fromResult(persistIntradaySnapshotRows(snapshot)).pipe(
        Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })),
      )
      return { binding, ...quotePrices, decisionMarketDataRows }
    })
    const policyHash = yield* Effect.fromResult(
      hashObserveMaterial('risk-policy-hash', 'execution close risk policy is not canonicalizable', policy),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const plannerSessionDate = cycle.identity.executionSessionDate
    const commonPlannerInput = {
      strategyName: cycle.identity.strategyName,
      cycleId: cycle.identity.cycleId,
      decisionHash: closeDecisionHash,
      policyHash,
      accountId: cycle.identity.accountId,
      signalDate: plannerSessionDate,
      targetWeights: closeDecision.targetWeights,
      brokerState: reconciliation.brokerState,
      precision: executionModel.precision,
      maximumInputAgeMs: Math.min(policy.maxBrokerStateAgeMs, policy.maxMarketDataAgeMs),
      submissionCutoffAt: closeExpiresAt,
      observedAt: evaluatedAt,
    }
    const reconciledPositionClose =
      closeExecutionMarketData.binding.schemaVersion === reconciledPositionLiquidationBindingSchemaVersion
    const prices = yield* Effect.fromResult(
      reconciledPositionClose
        ? reconciledPositionReferencePrices(plannerSessionDate, closeExecutionMarketData.binding)
        : intradayReferencePrices(plannerSessionDate, closeExecutionMarketData.binding, {
            priceMicros: closeExecutionMarketData.askPriceMicros,
            bidPriceMicros: closeExecutionMarketData.bidPriceMicros,
            askPriceMicros: closeExecutionMarketData.askPriceMicros,
          }),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const plannerInput: TargetPlannerInput = {
      schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
      ...commonPlannerInput,
      referencePrices: prices,
      precision: {
        quantityIncrementMicros: requiresFractionalClose || reconciledPositionClose ? '1' : '1000000',
        priceIncrementMicros: executionModel.precision.priceIncrementMicros,
        minimumBuyNotionalMicros: executionModel.precision.minimumBuyNotionalMicros,
      },
      allocationCapitalMicros: '0',
      executionTerms: reconciledPositionClose
        ? {
            executionPurpose: 'forced-close',
            orderType: OrderType.Market,
            timeInForce: TimeInForce.Day,
            priceReference: 'reconciled-broker-position-mark',
            snapshotId: closeExecutionMarketData.binding.snapshotId,
            snapshotContentHash: closeExecutionMarketData.binding.contentHash,
            maximumBuyQuantityMicros: maximumCloseBuyQuantityMicros,
            maximumSellQuantityMicros: maximumCloseSellQuantityMicros,
          }
        : requiresFractionalClose
          ? {
              executionPurpose: 'fractional-close',
              orderType: OrderType.Market,
              timeInForce: TimeInForce.Day,
              priceReference: 'verified-adverse-quote-boundary',
              snapshotId: closeExecutionMarketData.binding.snapshotId,
              snapshotContentHash: closeExecutionMarketData.binding.contentHash,
              maximumBuyQuantityMicros: maximumCloseBuyQuantityMicros,
              maximumSellQuantityMicros: maximumCloseSellQuantityMicros,
            }
          : {
              executionPurpose: 'forced-close',
              orderType: OrderType.Limit,
              timeInForce: TimeInForce.ImmediateOrCancel,
              priceReference: 'verified-adverse-quote-boundary',
              snapshotId: closeExecutionMarketData.binding.snapshotId,
              snapshotContentHash: closeExecutionMarketData.binding.contentHash,
              maximumBuyQuantityMicros: maximumCloseBuyQuantityMicros,
              maximumSellQuantityMicros: maximumCloseSellQuantityMicros,
            },
    }
    const targetPlan = yield* Effect.fromResult(planTargets(plannerInput)).pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })),
    )
    const riskInputs = yield* Effect.fromResult(
      reduceRiskInputs({
        executionModel,
        reconciliation,
        authorityObservation: executionAuthority,
        executionSession,
        targetPlan,
        snapshotContentHash: closeExecutionMarketData.binding.contentHash,
        executionMarketData: closeExecutionMarketData.binding,
        evaluatedAt,
        closeOnlyExpiresAt: closeExpiresAt,
      }),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    return yield* buildExecutionDecision({
      cycle,
      snapshot: {
        snapshotId: entryDocument.bindings.snapshotId,
        contentHash: entryDocument.bindings.snapshotContentHash,
        finalizedAt: entryDocument.bindings.snapshotFinalizedAt,
      },
      compiledDecision: closeDecision,
      ...(closeExecutionMarketData.decisionMarketDataRows === undefined
        ? {}
        : { decisionMarketDataRows: closeExecutionMarketData.decisionMarketDataRows }),
      executionMarketData: closeExecutionMarketData.binding,
      plannerInput,
      targetPlan,
      policy,
      riskInputs,
      authorityGenerationHash: input.authorityGenerationHash,
      executionSession,
      submissionCutoffAt: closeExpiresAt,
      ...(replanGenerationHash === undefined ? {} : { replanGenerationHash }),
    }).pipe(
      Effect.mapError((cause) => {
        const converted = decisionBuildError(cause)
        return mutationRunnerError({
          message: 'deterministic execution close plan construction failed',
          cause: converted,
          failure: converted.failure === 'not-ready' ? 'contract' : converted.failure,
        })
      }),
    )
  })
}

export const observePass = (
  recordPass: Parameters<AutonomousCycleStartup>[0]['recordPass'],
  observation: CyclePassObservation,
): Effect.Effect<AutonomousCyclePassObservation> => {
  const retained = retainAutonomousCyclePassObservation(observation)
  return recordPass(retained).pipe(Effect.as(retained))
}
