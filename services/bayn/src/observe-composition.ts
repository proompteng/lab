import { Clock, Data, Duration, Effect, Option, pipe, Ref, Result, Semaphore } from 'effect'

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
} from './cycle/runner'
import { validateCycleLoopInterval } from './cycle/runner/decisions'
import { CycleNotDueReconciliationError, type ReconciliationCadenceState } from './cycle/runner/model'
import { retainAutonomousCyclePassObservation } from './cycle/runner/pass-decisions'
import { CycleStore } from './cycle/store'
import {
  makePaperCycleClosure,
  type PaperCycleClosure,
  type PaperCycleClosureStoreShape,
} from './db/paper-cycle-closure'
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
import { IntentStore, type BlockedCycleIntentStoreShape } from './execution/intents'
import { MutationStore } from './execution/mutations'
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
import { decidePaperEpisodeCycleTerminalization, paperEpisodeAllocationCapitalMicros } from './paper-episode'
import {
  Authority,
  IntentState,
  OrderSide,
  OrderType,
  TerminalOutcome,
  TimeInForce,
  type AuthorityState,
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
import { currentUtcInstant, utcInstantFromEpochMillis } from './time'
import type { AutonomousCyclePassObservation } from './runtime-state'
import {
  planTargets,
  type SignalSessionReferencePrices,
  type TargetPlannerInput,
  type TargetPlannerFailure,
  type TargetPlanResult,
  TargetPlanStatus,
} from './target-planner'
import { strategyApplication, type CompiledStrategyDecision, type StrategyRuntime } from './strategy'
import type { DecisionPlan } from './types'
import {
  appendPendingMutationOrder,
  countOpenPositions,
  decidePendingMutationObservation,
  decideMutationIntentSettlement,
  decidePaperCycleCompletion,
  decidePreparedMutationIntent,
  decidePreparedMutationIntentAdmission,
  decidePreparedMutationRecovery,
  expiredPaperPlanTerminalReason,
  mutationIntentReconciliationDelayMs,
  mutationRecoveryIsDue,
  paperSubmitExpiresAt,
  paperCycleHasFilledIntent,
  paperClosePlanNeedsResidualReplan,
  projectWorstCasePendingMutationPosition,
  type BoundMutationCycleOutcome,
  type MutationIntentExecutionResult,
  type PendingMutationObservationDecision,
  type PaperCycleIntentTerminalEvidence,
  type PaperCycleReconciliationEvidence,
  type PaperCycleCompletionDecision,
  type PreparedMutationCycleStep,
  type PreparedMutationIntentAdmissionFailure,
  type PreparedMutationIntentDecision,
  type PreparedMutationIntentDecisionFailure,
  type PreparedMutationRecoveryDecision,
  type MutationIntentSettlementDecision,
} from './observe-composition/mutation-decisions'
import {
  executeMutationIntent,
  executeMutationIntentWithExecutor,
  mutationRunnerError,
  restrictMutationAuthority,
  restrictMutationLoopFailure,
} from './observe-composition/mutation-interpreter'
import {
  prepareMutationIntent,
  type MutationPreparationFacts,
  type MutationPreparationFactsRequest,
} from './observe-composition/mutation-intent-interpreter'
import { Pipeable } from './pipeable'

export {
  appendPendingMutationOrder,
  countOpenPositions,
  decidePendingMutationObservation,
  decideMutationIntentSettlement,
  decidePaperCycleCompletion,
  decidePreparedMutationIntent,
  decidePreparedMutationIntentAdmission,
  decidePreparedMutationRecovery,
  executeMutationIntent,
  expiredPaperPlanTerminalReason,
  mutationIntentReconciliationDelayMs,
  mutationRecoveryIsDue,
  paperSubmitExpiresAt,
  paperCycleHasFilledIntent,
  paperClosePlanNeedsResidualReplan,
  projectWorstCasePendingMutationPosition,
}
export type {
  MutationIntentExecutionResult,
  MutationIntentSettlementDecision,
  PendingMutationObservationDecision,
  PaperCycleCompletionDecision,
  PaperCycleIntentTerminalEvidence,
  PaperCycleReconciliationEvidence,
  PreparedMutationIntentAdmissionFailure,
  PreparedMutationIntentDecision,
  PreparedMutationIntentDecisionFailure,
  PreparedMutationRecoveryDecision,
}

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

const loadObserveRiskPolicyDataFirst = (accountId: string, allowedSymbols: readonly string[]) =>
  decodePolicy({
    schemaVersion: 'bayn.paper-risk-policy.v2',
    accountId,
    brokerMode: BrokerMode.Paper,
    allowedSymbols: [...allowedSymbols].sort(),
    allowedOrderTypes: [OrderType.Market],
    allowedTimeInForce: [TimeInForce.Day],
    maxOpenOrders: allowedSymbols.length,
    ...observeRiskLimits,
  })

export const loadObserveRiskPolicy = Pipeable.dual(2, loadObserveRiskPolicyDataFirst)

type ObserveStrategy = StrategyRuntime

class ReconciliationPassTimeoutError extends Data.TaggedError('ReconciliationPassTimeoutError')<{
  readonly timeoutMs: number
  readonly message: string
}> {}

export type ReconciliationPassError = Effect.Error<typeof runOnce> | ReconciliationPassTimeoutError

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
    | 'paper-episode-allocation'
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
              operationalError({
                component: 'market-data',
                operation: 'load-snapshot-publication',
                message: 'bound cycle snapshot publication read failed',
                cause,
              }),
            ),
          ),
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

type CompiledObserveStrategyDecision = CompiledStrategyDecision & { readonly decision: DecisionPlan }

const unwrapStrategyApplicationFailure = (cause: unknown): unknown => {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    '_tag' in cause &&
    cause._tag === 'StrategyApplicationFailure' &&
    'cause' in cause
  ) {
    return cause.cause
  }
  return cause
}

const compileObserveStrategyDecision = <R>(
  input: ObserveDecisionInput<R>,
  facts: ObserveDecisionFacts,
  executionSession: ExecutionSessionBinding,
): Effect.Effect<CompiledObserveStrategyDecision, OperationalError> =>
  Effect.fromResult(
    (() => {
      const application = strategyApplication(input.strategy)
      return pipe(
        application.parseManifest(facts.snapshot.manifest),
        Result.flatMap((manifest) =>
          application.evaluateCurrentDecision(facts.snapshot.bars, manifest, executionSession),
        ),
        Result.map((compiled) => ({ ...compiled, decision: compiled.decision as DecisionPlan })),
      )
    })(),
  ).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'current-decision',
        message: 'current strategy decision compilation failed',
        cause: unwrapStrategyApplicationFailure(cause),
      }),
    ),
  )

const prepareObservePlanner = <R>(
  input: ObserveDecisionInput<R>,
  facts: ObserveDecisionFacts,
  compiled: CompiledObserveStrategyDecision,
  overrides: ObservePlannerOverrides = {},
): Result.Result<ObservePlannerPreparation, ObserveDecisionCompositionFailure> =>
  Result.flatMap(referencePrices(compiled.signalDate, facts.evaluatedAt, compiled.priceMicros), (prices) =>
    Result.flatMap(
      hashObserveMaterial('risk-policy-hash', 'OBSERVE risk policy is not canonicalizable', input.policy),
      (policyHash) =>
        Result.map(
          hashObserveMaterial(
            'compiled-decision-hash',
            'current strategy decision is not canonicalizable',
            compiled.decision,
          ),
          (decisionHash) => {
            const commonPlannerInput = {
              strategyName: input.cycle.identity.strategyName,
              cycleId: input.cycle.identity.cycleId,
              decisionHash,
              policyHash,
              accountId: input.cycle.identity.accountId,
              signalDate: input.cycle.identity.signalSessionDate,
              targetWeights: overrides.targetWeights ?? compiled.decision.targetWeights,
              referencePrices: prices,
              brokerState: facts.reconciliation.brokerState,
              precision: input.executionModel.precision,
              maximumInputAgeMs: Math.min(input.policy.maxBrokerStateAgeMs, input.policy.maxMarketDataAgeMs),
              submissionCutoffAt: overrides.submissionCutoffAt ?? input.cycle.window.submissionCutoffAt,
              observedAt: facts.evaluatedAt,
            }
            return {
              prices,
              plannerInput:
                overrides.allocationCapitalMicros === undefined
                  ? {
                      schemaVersion: 'bayn.paper-target-planner-input.v1' as const,
                      ...commonPlannerInput,
                    }
                  : {
                      schemaVersion: 'bayn.paper-target-planner-input.v2' as const,
                      ...commonPlannerInput,
                      allocationCapitalMicros: overrides.allocationCapitalMicros,
                    },
            }
          },
        ),
    ),
  )

type RiskInputPreparation = {
  readonly executionModel: CausalProtocol['executionModel']
  readonly reconciliation: ReconciliationPassResult
  readonly authorityObservation: ObserveAuthorityObservation
  readonly executionSession: ExecutionSessionBinding
  readonly targetPlan: TargetPlanResult
  readonly prices: SignalSessionReferencePrices
  readonly snapshotContentHash: string
  readonly evaluatedAt: string
  readonly closeOnlyExpiresAt?: string
}

const reduceRiskInputs = (
  input: RiskInputPreparation,
): Result.Result<readonly ShadowDeltaRiskInput[], ObserveDecisionCompositionFailure> =>
  Result.mapError(
    Result.all(
      input.targetPlan.intentTargets.map((target) => {
        const referencePriceMicros = input.prices.priceMicros[target.symbol]
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
          makeFillTerms(
            target.side === OrderSide.Buy ? 'buy' : 'sell',
            BigInt(target.quantityMicros),
            referencePrice,
            input.executionModel,
            MICROS,
          ),
          (fillTerms): ShadowDeltaRiskInput => {
            const state: State = {
              schemaVersion: 'bayn.paper-risk-state.v2',
              brokerMode: BrokerMode.Paper,
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
              marketDataHash: input.snapshotContentHash,
              referencePriceMicros: referencePrice.toString(),
              expectedExecutionPriceMicros: fillTerms.fillPriceMicros.toString(),
              marketDataObservedAt: input.evaluatedAt,
              executionSession: input.executionSession,
              reservedBuyingPowerMicros: '0',
              evaluatedAt: input.evaluatedAt,
              ...(input.closeOnlyExpiresAt === undefined
                ? {}
                : { closeOnly: true as const, closeOnlyExpiresAt: input.closeOnlyExpiresAt }),
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

const reduceObserveRiskInputs = <R>(
  input: ObserveDecisionInput<R>,
  facts: ObserveDecisionFacts,
  authorityObservation: ObserveAuthorityObservation,
  executionSession: ExecutionSessionBinding,
  targetPlan: TargetPlanResult,
  prices: SignalSessionReferencePrices,
  closeOnlyExpiresAt?: string,
): Result.Result<readonly ShadowDeltaRiskInput[], ObserveDecisionCompositionFailure> =>
  reduceRiskInputs({
    executionModel: input.executionModel,
    reconciliation: facts.reconciliation,
    authorityObservation,
    executionSession,
    targetPlan,
    prices,
    snapshotContentHash: facts.snapshot.manifest.finalizedSnapshot.contentHash,
    evaluatedAt: facts.evaluatedAt,
    ...(closeOnlyExpiresAt === undefined ? {} : { closeOnlyExpiresAt }),
  })

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
    const allocationCapitalMicros =
      authorityRequirement === Authority.Paper
        ? yield* Effect.fromResult(
            paperEpisodeAllocationCapitalMicros({
              accountEquityMicros: BigInt(facts.reconciliation.brokerState.account.equityMicros),
              dailyTradedNotionalMicros: BigInt(facts.reconciliation.riskContext.dailyTradedNotionalMicros),
              maxGrossExposureMicros: BigInt(input.policy.maxGrossExposureMicros),
              maxNetExposureMicros: BigInt(input.policy.maxNetExposureMicros),
              maxDailyTradedNotionalMicros: BigInt(input.policy.maxDailyTradedNotionalMicros),
              maxAdverseSlippageBps: BigInt(input.policy.maxAdverseSlippageBps),
              positions: facts.reconciliation.brokerState.positions,
              referencePriceMicros: compiled.priceMicros,
            }),
          ).pipe(
            Effect.mapError((cause) =>
              compositionFailure(
                'paper-episode-allocation',
                'PAPER entry cannot fit its complete sell-plus-buy plan inside the remaining turnover budget',
                cause,
              ),
            ),
          )
        : undefined
    const plannerPreparation = yield* Effect.fromResult(
      prepareObservePlanner(
        input,
        facts,
        compiled,
        authorityRequirement === Authority.Paper && allocationCapitalMicros !== undefined
          ? { allocationCapitalMicros: allocationCapitalMicros.toString() }
          : {},
      ),
    )
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
      : yield* buildPaperDecision({
          ...decisionInput,
          authorityGenerationHash: input.authorityGenerationHash,
          executionSession,
        })
  })
}

export const buildMutationShadowCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
): Effect.Effect<PaperDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R> =>
  buildCycleDecision(input, Authority.Paper)

const makeClosingReferencePrices = (
  entryDocument: PaperDecisionDocument,
  positions: ReconciliationPassResult['brokerState']['positions'],
  signalDate: SignalSessionReferencePrices['signalDate'],
  observedAt: string,
): Result.Result<SignalSessionReferencePrices, ObserveDecisionCompositionFailure> => {
  const prices = new Map(entryDocument.targetPlan.targets.map((target) => [target.symbol, target.referencePriceMicros]))
  for (const position of positions) {
    const observedPrice = position.marketPriceMicros
    const fallbackPrice = prices.get(position.symbol)
    if (/^[1-9][0-9]*$/.test(observedPrice)) {
      prices.set(position.symbol, observedPrice)
    } else if (fallbackPrice === undefined) {
      return Result.fail(
        compositionFailure(
          'reference-prices',
          `close position ${position.symbol} has no positive persisted reference price`,
        ),
      )
    }
  }
  return referencePrices(
    signalDate,
    observedAt,
    Object.fromEntries([...prices.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
  )
}

const makeClosingDecisionPlan = (
  signalDate: SignalSessionReferencePrices['signalDate'],
  symbols: readonly string[],
): Result.Result<DecisionPlan, ObserveDecisionCompositionFailure> => {
  const orderedSymbols = [...new Set(symbols)].sort()
  const sessionsHash = canonicalHashV1Result({
    schemaVersion: 'bayn.paper-close-decision-sessions.v1',
    signalDate,
    symbols: orderedSymbols,
  })
  if (Result.isFailure(sessionsHash)) {
    return Result.fail(
      compositionFailure(
        'compiled-decision-hash',
        'close decision session identity is not canonicalizable',
        sessionsHash.failure,
      ),
    )
  }
  return Result.succeed({
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate,
    covarianceWindow: {
      returnCount: 1,
      firstSession: signalDate,
      lastSession: signalDate,
      sessionsHash: sessionsHash.success,
    },
    estimatedAnnualizedPortfolioVolatility: 0,
    exposureScale: 0,
    targetWeights: Object.fromEntries(orderedSymbols.map((symbol) => [symbol, 0])),
    signals: orderedSymbols.map((symbol) => ({
      symbol,
      horizons: [{ horizonSessions: 1, return: 0, normalizedTrend: 0 }],
      dailyVolatility: 0,
      annualizedVolatility: 0,
      compositeScore: 0,
      positiveScore: 0,
      eligible: false,
      uncappedWeight: 0,
      cappedWeight: 0,
      targetWeight: 0,
    })),
  })
}

const recoverPaperExecutionSession = (
  preparation: ObserveStartupPreparation,
  cycle: AutonomousCycle,
  entryDocument: PaperDecisionDocument,
): Result.Result<ExecutionSessionBinding, ObserveDecisionCompositionFailure> => {
  const bindRecoveredSession = (input: Parameters<typeof bindCycleExecutionSession>[0]) =>
    Result.mapError(bindCycleExecutionSession(input), (cause) =>
      compositionFailure('cycle-binding', 'PAPER execution-session binding does not match its cycle', cause),
    )
  const persistedSession = entryDocument.executionSession
  if (persistedSession !== undefined) {
    return bindRecoveredSession({
      cycle,
      signal: persistedSession.signal,
      planningBrokerState: persistedSession.planningBrokerState,
      calendar: persistedSession.calendar,
      executionModel: preparation.executionModel,
    })
  }

  const legacyCalendarMaterial = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: {
      start: cycle.identity.signalSessionDate,
      end: cycle.identity.executionSessionDate,
    },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: cycle.window.executionSessionDate,
        openAt: cycle.window.executionOpenAt,
        closeAt: cycle.window.executionCloseAt,
      },
    ],
  }
  return Result.flatMap(
    Result.mapError(canonicalHashV1Result(legacyCalendarMaterial), (cause) =>
      compositionFailure('cycle-binding', 'legacy PAPER close calendar material is not canonicalizable', cause),
    ),
    (normalizedResponseHash) =>
      bindRecoveredSession({
        cycle,
        signal: {
          sessionDate: cycle.identity.signalSessionDate,
          finalizedAt: entryDocument.bindings.snapshotFinalizedAt,
          contentHash: entryDocument.bindings.snapshotContentHash,
        },
        planningBrokerState: {
          observedAt: entryDocument.createdAt,
          contentHash: entryDocument.bindings.planningBrokerStateHash,
        },
        calendar: { ...legacyCalendarMaterial, normalizedResponseHash },
        executionModel: preparation.executionModel,
      }),
  )
}

export interface BuildClosingPaperCycleDecisionInput {
  readonly input: ObserveAutonomousCycleInput
  readonly preparation: ObserveStartupPreparation
  readonly policy: Policy
  readonly cycle: AutonomousCycle
  readonly entryDocument: PaperDecisionDocument
  readonly reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>
  readonly closeExpiresAt: string
  readonly replanGenerationHash?: string
}

export const buildClosingPaperCycleDecision = (
  request: BuildClosingPaperCycleDecisionInput,
): Effect.Effect<PaperDecisionDocument, CycleRunnerError, ObserveDecisionRuntime> => {
  const { input, preparation, policy, cycle, entryDocument, reconcile, closeExpiresAt, replanGenerationHash } = request
  return Effect.gen(function* () {
    const reconciliation = yield* reconcile.pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: 'PAPER close reconciliation failed', cause })),
    )
    const evaluatedAt = yield* currentUtcInstant
    const executionAuthority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(reconciliation, policy, input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const executionSession = yield* Effect.fromResult(
      recoverPaperExecutionSession(preparation, cycle, entryDocument),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const symbols = [
      ...entryDocument.targetPlan.targets.map((target) => target.symbol),
      ...reconciliation.brokerState.positions.map((position) => position.symbol),
    ]
    const closeDecision = yield* Effect.fromResult(
      makeClosingDecisionPlan(cycle.identity.signalSessionDate, symbols),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const closeDecisionHash = yield* Effect.fromResult(
      hashObserveMaterial('compiled-decision-hash', 'close decision is not canonicalizable', closeDecision),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const prices = yield* Effect.fromResult(
      makeClosingReferencePrices(
        entryDocument,
        reconciliation.brokerState.positions,
        cycle.identity.signalSessionDate,
        evaluatedAt,
      ),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const policyHash = yield* Effect.fromResult(
      hashObserveMaterial('risk-policy-hash', 'PAPER close risk policy is not canonicalizable', policy),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const plannerInput: TargetPlannerInput = {
      schemaVersion: 'bayn.paper-target-planner-input.v1',
      strategyName: cycle.identity.strategyName,
      cycleId: cycle.identity.cycleId,
      decisionHash: closeDecisionHash,
      policyHash,
      accountId: cycle.identity.accountId,
      signalDate: cycle.identity.signalSessionDate,
      targetWeights: closeDecision.targetWeights,
      referencePrices: prices,
      brokerState: reconciliation.brokerState,
      precision: preparation.executionModel.precision,
      maximumInputAgeMs: Math.min(policy.maxBrokerStateAgeMs, policy.maxMarketDataAgeMs),
      submissionCutoffAt: closeExpiresAt,
      observedAt: evaluatedAt,
    }
    const targetPlan = yield* Effect.fromResult(planTargets(plannerInput)).pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })),
    )
    const riskInputs = yield* Effect.fromResult(
      reduceRiskInputs({
        executionModel: preparation.executionModel,
        reconciliation,
        authorityObservation: executionAuthority,
        executionSession,
        targetPlan,
        prices,
        snapshotContentHash: entryDocument.bindings.snapshotContentHash,
        evaluatedAt,
        closeOnlyExpiresAt: closeExpiresAt,
      }),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    return yield* buildPaperDecision({
      cycle,
      snapshot: {
        snapshotId: entryDocument.bindings.snapshotId,
        contentHash: entryDocument.bindings.snapshotContentHash,
        finalizedAt: entryDocument.bindings.snapshotFinalizedAt,
      },
      compiledDecision: closeDecision,
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
          message: 'deterministic PAPER close plan construction failed',
          cause: converted,
          failure: converted.failure,
        })
      }),
    )
  })
}

const observePass = (
  recordPass: Parameters<AutonomousCycleStartup>[0]['recordPass'],
  observation: CyclePassObservation,
): Effect.Effect<AutonomousCyclePassObservation> => {
  const retained = retainAutonomousCyclePassObservation(observation)
  return recordPass(retained).pipe(Effect.as(retained))
}

export type ObserveAutonomousCycleInput = {
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly pollIntervalMs: number
  readonly reconciliationIntervalMs: number
  readonly reconciliationPassTimeoutMs: number
  readonly strategy: StrategyRuntime
  readonly cycleCadence?: 'MONTHLY' | 'PAPER_BOOTSTRAP'
  readonly mutationPhase?: 'ENTRY' | 'CLOSE'
  readonly paperCycleClosureStore?: PaperCycleClosureStoreShape
  readonly blockedCycleIntentStore?: BlockedCycleIntentStoreShape
  readonly paperEpisodeCutoffAt?: string
  readonly paperEpisodeCloseSubmitCutoffAt?: string
  readonly paperEpisodeExpiresAt?: string
  readonly onClosedCycle?: (cycleId: string, observedAt: string) => Effect.Effect<void>
  /** Runs due lifecycle maintenance inside the same serialized command as the cycle pass. */
  readonly beforeLifecycleAdvance?: Effect.Effect<LifecycleAdvanceDisposition, CycleRunnerError>
  readonly interpretCycleDriver?: RecoveryFirstCycleDriverInterpreter
}

export type LifecycleAdvanceDisposition = 'CONTINUE' | 'COMPLETED'

export const paperEpisodeCloseGraceMs = 15 * 60_000

export const paperEpisodeCloseExpiresAt = (authorityExpiresAt: string): string =>
  utcInstantFromEpochMillis(Date.parse(authorityExpiresAt) + paperEpisodeCloseGraceMs)

/** Receipt finalization remains bounded, but survives late close settlement and transient read failures. */
export const paperEpisodeReceiptFinalizationGraceMs = 15 * 60_000

export const paperEpisodeReceiptFinalizationExpiresAt = (authorityExpiresAt: string): string =>
  utcInstantFromEpochMillis(
    Date.parse(paperEpisodeCloseExpiresAt(authorityExpiresAt)) + paperEpisodeReceiptFinalizationGraceMs,
  )

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
export type RecoveryFirstRuntime = ObserveRuntime | IntentStore | MutationStore

export type ObserveStartupPreparation = {
  readonly executionModel: CausalProtocol['executionModel']
  readonly executionPolicy: CycleExecutionPolicy
  readonly strategyProtocolHash: string
}

export const prepareObserveStartup = (
  input: ObserveAutonomousCycleInput,
): Result.Result<ObserveStartupPreparation, OperationalError> => {
  const executionModel = strategyApplication(input.strategy).definition.parameters.executionModel
  if (executionModel.schemaVersion !== 'bayn.execution-model.v2') {
    return Result.fail(
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: 'autonomous cycles require the causal v2 execution model',
      }),
    )
  }
  return Result.map(
    Result.mapError(makeCycleExecutionPolicyFromModel(executionModel), (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-policy',
        message: 'autonomous cycle execution policy construction failed',
        cause,
      }),
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
        operationalError({
          component: 'database',
          operation: 'authority',
          message: 'OBSERVE authority initialization returned incompatible state',
        }),
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
      operationalError({
        component: 'database',
        operation: 'authority',
        message: 'OBSERVE authority initialization failed',
        cause,
      }),
    ),
    Effect.flatMap((authority) => Effect.fromResult(validateObserveAuthorityInitialization(authority, input))),
  )

export type MutationAutonomousCycleInput = ObserveAutonomousCycleInput & {
  readonly executionProgram: ExecutionProgram
}

type PaperExecutionCapability =
  | { readonly _tag: 'RecoveryOnly' }
  | { readonly _tag: 'Mutation'; readonly executionProgram: ExecutionProgram }

type PaperMutationLogContext = {
  readonly cycleId: string
  readonly intentId: string
  readonly mutationAction: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT'
  readonly mutationPhase: 'CLOSE' | 'ENTRY'
}

type PostMutationReconciliation = {
  readonly _tag: 'PostMutationReconciliation'
  readonly cycle: AutonomousCycle
  readonly delayMs: number
  readonly logContext: PaperMutationLogContext
  readonly observedAt: string
}

type BoundPaperCycleExecutionOutcome = BoundMutationCycleOutcome | PostMutationReconciliation
type RecoveryFirstCyclePassResult = CycleRunResult | PostMutationReconciliation

const isPostMutationReconciliation = (result: RecoveryFirstCyclePassResult): result is PostMutationReconciliation =>
  '_tag' in result && result._tag === 'PostMutationReconciliation'

export const paperMutationSubmissionAllowed = (input: {
  readonly capability: PaperExecutionCapability['_tag']
  readonly closeOnly: boolean
  readonly paperEpisodeCutoffAt?: string
  readonly paperEpisodeCloseSubmitCutoffAt?: string
  readonly observedAt: string
}): boolean =>
  input.capability === 'Mutation' &&
  (input.closeOnly
    ? input.paperEpisodeCloseSubmitCutoffAt === undefined || input.observedAt < input.paperEpisodeCloseSubmitCutoffAt
    : input.paperEpisodeCutoffAt === undefined || input.observedAt < input.paperEpisodeCutoffAt)

type RecoveryFirstDecisionBuilder = (
  cycle: AutonomousCycle,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
) => Effect.Effect<CycleDecisionDocument, CycleDecisionBuildError, ObserveDecisionRuntime>

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
        operationalError({
          component: 'config',
          operation: 'cycle-loop',
          message: 'mutation cycle execution program does not match its account, authority generation, and strategy',
        }),
      )
    : Result.succeed(undefined)
}

const readBoundMutationDocument = (
  cycle: AutonomousCycle,
): Effect.Effect<CycleDecisionDocument, CycleRunnerError, CycleStore> =>
  CycleStore.pipe(
    Effect.flatMap((store) => store.readDecisionDocument(cycle.identity.cycleId)),
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'durable mutation-cycle shadow plan read failed', cause, failure: 'store' }),
    ),
    Effect.flatMap((document) =>
      Option.match(document, {
        onNone: () =>
          Effect.fail(
            mutationRunnerError({
              message: 'decision-bound mutation cycle is missing its durable shadow plan',
              cause: undefined,
              failure: 'store',
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  )

const readPaperCycleClosure = (
  cycleId: string,
  store: PaperCycleClosureStoreShape,
): Effect.Effect<PaperCycleClosure | undefined, CycleRunnerError> =>
  store.read(cycleId).pipe(
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'durable PAPER close plan read failed', cause, failure: 'store' }),
    ),
    Effect.map(Option.getOrUndefined),
  )

const readLatestPaperCycleCloseReplan = (
  cycleId: string,
  store: PaperCycleClosureStoreShape,
): Effect.Effect<PaperCycleClosure | undefined, CycleRunnerError> =>
  store.readLatestReplan(cycleId).pipe(
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'durable PAPER close replan read failed', cause, failure: 'store' }),
    ),
    Effect.map(Option.getOrUndefined),
  )

const closePlanNeedsResidualReplan = (
  document: PaperDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<boolean, CycleRunnerError, ObserveDecisionRuntime | IntentStore> =>
  Effect.gen(function* () {
    const intentStore = yield* IntentStore
    const records = yield* Effect.forEach(
      document.orderedIntentIds,
      (intentId) =>
        intentStore
          .read(intentId)
          .pipe(
            Effect.mapError((cause) =>
              mutationRunnerError({ message: 'PAPER close intent recovery read failed', cause, failure: 'store' }),
            ),
          ),
      { concurrency: 1 },
    )
    if (
      records.length === 0 ||
      records.some(Option.isNone) ||
      records.some((record) => Option.isSome(record) && record.value.intent.state !== IntentState.Terminal)
    ) {
      return false
    }
    const facts = yield* reconcile.pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: 'PAPER residual close reconciliation failed', cause })),
    )
    return paperClosePlanNeedsResidualReplan(
      records
        .map((record) => (Option.isSome(record) ? record.value.intent : undefined))
        .filter((intent): intent is NonNullable<typeof intent> => intent !== undefined),
      countOpenPositions(facts.brokerState.positions),
    )
  })

const ensurePaperCycleClosure = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  entryDocument: PaperDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<PaperDecisionDocument | undefined, CycleRunnerError, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const cutoffAt = input.paperEpisodeCutoffAt
    const closeExpiresAt = input.paperEpisodeExpiresAt
    const store = input.paperCycleClosureStore
    if (cutoffAt === undefined || closeExpiresAt === undefined || store === undefined) return undefined
    const observedAt = yield* currentUtcInstant
    if (observedAt < cutoffAt) return undefined
    const existing = yield* readPaperCycleClosure(cycle.identity.cycleId, store)
    const entryDecisionHash = cycle.bindings.decisionHash
    if (entryDecisionHash === undefined) {
      return yield* mutationRunnerError({
        message: 'active PAPER cycle has no immutable entry decision hash for its close plan',
        cause: undefined,
        failure: 'contract',
      })
    }
    if (existing === undefined) {
      const document = yield* buildClosingPaperCycleDecision({
        input,
        preparation,
        policy,
        cycle,
        entryDocument,
        reconcile,
        closeExpiresAt,
      })
      if (!document.dispatchable || document.targetPlan.status !== TargetPlanStatus.Planned) return undefined
      const closure = yield* Effect.fromResult(
        makePaperCycleClosure({
          schemaVersion: 'bayn.paper-cycle-closure.v1',
          cycleId: cycle.identity.cycleId,
          entryDecisionHash,
          document,
          createdAt: document.createdAt,
          expiresAt: closeExpiresAt,
        }),
      ).pipe(
        Effect.mapError((cause) =>
          mutationRunnerError({ message: 'PAPER close plan canonical binding failed', cause, failure: 'contract' }),
        ),
      )
      const stored = yield* store
        .bind(closure)
        .pipe(
          Effect.mapError((cause) =>
            mutationRunnerError({ message: 'PAPER close plan durable bind failed', cause, failure: 'store' }),
          ),
        )
      return stored.document
    }

    const latestReplan = yield* readLatestPaperCycleCloseReplan(cycle.identity.cycleId, store)
    const active = latestReplan ?? existing
    if (!(yield* closePlanNeedsResidualReplan(active.document, reconcile))) return active.document

    const document = yield* buildClosingPaperCycleDecision({
      input,
      preparation,
      policy,
      cycle,
      entryDocument,
      reconcile,
      closeExpiresAt,
      replanGenerationHash: active.contentHash,
    })
    if (!document.dispatchable || document.targetPlan.status !== TargetPlanStatus.Planned) return active.document
    const closure = yield* Effect.fromResult(
      makePaperCycleClosure({
        schemaVersion: 'bayn.paper-cycle-closure.v1',
        cycleId: cycle.identity.cycleId,
        entryDecisionHash,
        document,
        createdAt: document.createdAt,
        expiresAt: closeExpiresAt,
      }),
    ).pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({
          message: 'PAPER residual close plan canonical binding failed',
          cause,
          failure: 'contract',
        }),
      ),
    )
    const stored = yield* store
      .bindReplan(closure)
      .pipe(
        Effect.mapError((cause) =>
          mutationRunnerError({ message: 'PAPER residual close plan durable bind failed', cause, failure: 'store' }),
        ),
      )
    return stored.document
  })

const entryPaperCycleHasUnsuccessfulIntent = (
  document: PaperDecisionDocument,
): Effect.Effect<boolean, CycleRunnerError, IntentStore> =>
  Effect.gen(function* () {
    const store = yield* IntentStore
    const records = yield* Effect.forEach(
      document.orderedIntentIds,
      (intentId) =>
        store
          .read(intentId)
          .pipe(
            Effect.mapError((cause) =>
              mutationRunnerError({ message: 'entry PAPER intent read failed', cause, failure: 'store' }),
            ),
          ),
      { concurrency: 1 },
    )
    return records.some(
      (record) =>
        Option.isSome(record) &&
        record.value.intent.state === IntentState.Terminal &&
        record.value.intent.terminalOutcome !== TerminalOutcome.Filled,
    )
  })

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

const readMutationPreparationFacts = (
  request: MutationPreparationFactsRequest<
    ObserveDecisionRuntime,
    ReconciliationPassError,
    ObserveAutonomousCycleInput,
    ObserveStartupPreparation
  >,
): Effect.Effect<MutationPreparationFacts, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const decisionInput = mutationDecisionInput(
      request.input,
      request.preparation,
      request.policy,
      request.cycle,
      request.reconcile,
    )
    const reads = yield* Effect.fromResult(prepareObserveDecisionReads(decisionInput)).pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({ message: 'mutation cycle decision reads are invalid', cause, failure: 'contract' }),
      ),
    )
    const facts = yield* readObserveDecisionFacts(decisionInput, reads).pipe(
      Effect.mapError((cause) => {
        const converted = decisionBuildError(cause)
        return mutationRunnerError({ message: converted.message, cause, failure: converted.failure })
      }),
    )
    const authority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(facts.reconciliation, request.policy, request.input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    return {
      snapshot: facts.snapshot.manifest.finalizedSnapshot,
      reconciliation: facts.reconciliation,
      authority: authority.authority,
      evaluatedAt: facts.evaluatedAt,
    }
  })

const readCloseMutationPreparationFacts = (
  request: MutationPreparationFactsRequest<
    ObserveDecisionRuntime,
    ReconciliationPassError,
    ObserveAutonomousCycleInput,
    ObserveStartupPreparation
  >,
): Effect.Effect<MutationPreparationFacts, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const reconciliation = yield* request.reconcile.pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: 'PAPER close reconciliation failed', cause })),
    )
    const evaluatedAt = yield* currentUtcInstant
    const authority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(reconciliation, request.policy, request.input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    return {
      snapshot: {
        contentHash: request.document.bindings.snapshotContentHash,
        finalizedAt: request.document.bindings.snapshotFinalizedAt,
      },
      reconciliation,
      authority: authority.authority,
      evaluatedAt,
    }
  })

export interface PrepareNextMutationIntentInput {
  readonly input: ObserveAutonomousCycleInput
  readonly preparation: ObserveStartupPreparation
  readonly policy: Policy
  readonly cycle: AutonomousCycle
  readonly document: PaperDecisionDocument
  readonly reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>
  readonly allowSubmit?: boolean
}

export const prepareNextMutationIntent = (
  request: PrepareNextMutationIntentInput,
): Effect.Effect<PreparedMutationCycleStep, CycleRunnerError, ObserveDecisionRuntime | IntentStore | MutationStore> =>
  prepareMutationIntent(
    request.input,
    request.preparation,
    request.policy,
    request.cycle,
    request.document,
    request.reconcile,
    request.allowSubmit ?? true,
    {
      now: currentUtcInstant,
      readFacts:
        request.input.mutationPhase === 'CLOSE' ? readCloseMutationPreparationFacts : readMutationPreparationFacts,
      restrictAuthority: restrictMutationAuthority,
    },
  )

const executeBoundPaperCycle = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  document: PaperDecisionDocument,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: PaperExecutionCapability,
): Effect.Effect<BoundPaperCycleExecutionOutcome, CycleRunnerError, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const closeDocument = yield* ensurePaperCycleClosure(input, preparation, policy, cycle, document, reconcile)
    const closeOnly = closeDocument !== undefined
    const phaseInput: ObserveAutonomousCycleInput = {
      ...input,
      ...(closeOnly ? { mutationPhase: 'CLOSE' as const } : { mutationPhase: 'ENTRY' as const }),
    }
    const activeDocument = closeDocument ?? document
    const step = yield* prepareNextMutationIntent({
      input: phaseInput,
      preparation,
      policy,
      cycle,
      document: activeDocument,
      reconcile,
      allowSubmit: paperMutationSubmissionAllowed({
        capability: capability._tag,
        closeOnly,
        ...(input.paperEpisodeCutoffAt === undefined ? {} : { paperEpisodeCutoffAt: input.paperEpisodeCutoffAt }),
        ...(input.paperEpisodeCloseSubmitCutoffAt === undefined
          ? {}
          : { paperEpisodeCloseSubmitCutoffAt: input.paperEpisodeCloseSubmitCutoffAt }),
        observedAt,
      }),
    })
    if (step._tag !== 'Execute') {
      if (step._tag !== 'Complete') return step
      const entryHasUnsuccessfulIntent =
        closeOnly || (input.paperEpisodeCutoffAt !== undefined && observedAt >= input.paperEpisodeCutoffAt)
          ? yield* entryPaperCycleHasUnsuccessfulIntent(document)
          : false
      const terminalization = decidePaperEpisodeCycleTerminalization({
        closeOnly,
        observedAt,
        ...(input.paperEpisodeCutoffAt === undefined ? {} : { entryCutoffAt: input.paperEpisodeCutoffAt }),
        entryHasUnsuccessfulIntent,
      })
      switch (terminalization._tag) {
        case 'WaitForClose':
          return { _tag: 'Wait', observedAt: step.observedAt }
        case 'Block':
          return { _tag: 'Block', reason: CycleTerminalReason.Risk, observedAt: step.observedAt }
        case 'Complete':
          return step
      }
    }
    const logContext: PaperMutationLogContext = {
      cycleId: cycle.identity.cycleId,
      intentId: step.intentId,
      mutationAction: step.action,
      mutationPhase: closeOnly ? 'CLOSE' : 'ENTRY',
    }
    yield* Effect.logInfo('PAPER mutation selected').pipe(Effect.annotateLogs(logContext))
    const execute =
      capability._tag === 'Mutation'
        ? executeMutationIntent(
            capability.executionProgram,
            step.intentId,
            step.action,
            step.action === 'SUBMIT' ? step.submitExpiresAt : undefined,
          )
        : executeMutationIntentWithExecutor({
            executor: { recover: recoverMutation },
            intentId: step.intentId,
            action: step.action,
            submitExpiresAt: step.action === 'SUBMIT' ? step.submitExpiresAt : undefined,
          })
    const executed = yield* execute.pipe(
      Effect.tapError((error) =>
        Effect.logError('PAPER mutation failed').pipe(Effect.annotateLogs({ ...logContext, failure: error.failure })),
      ),
    )
    yield* Effect.logInfo('PAPER mutation settled').pipe(
      Effect.annotateLogs({
        ...logContext,
        mutationOperation: executed.operation,
        mutationAdvanced: executed.mutationAdvanced,
        settlement: executed.settlement.outcome,
      }),
    )
    if (executed.operation === MutationOperation.Submit && executed.settlement.outcome !== 'accepted') {
      yield* restrictMutationAuthority(
        'PAPER autonomous cycle loop',
        `bound cycle ${cycle.identity.cycleId}: intent ${step.intentId} submit settled ${executed.settlement.outcome}`,
      )
    }
    if (executed.mutationAdvanced)
      return {
        _tag: 'PostMutationReconciliation',
        cycle,
        delayMs: mutationIntentReconciliationDelayMs(executed),
        logContext,
        observedAt: step.observedAt,
      }
    return { _tag: 'Wait' as const, observedAt: step.observedAt }
  })

const completePostMutationReconciliation = (
  pending: PostMutationReconciliation,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<CycleRunResult, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    if (pending.delayMs > 0) yield* Effect.sleep(Duration.millis(pending.delayMs))
    const reconciled = yield* reconcile.pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({ message: 'post-mutation reconciliation failed', cause, failure: 'operational' }),
      ),
    )
    yield* Effect.logInfo('PAPER mutation reconciled').pipe(
      Effect.annotateLogs({
        ...pending.logContext,
        accountingExact: reconciled.report.metrics.accountingExact,
        discrepancyCount: reconciled.report.reconciliation.discrepancies.length,
        reconciliationStatus: reconciled.report.reconciliation.status,
      }),
    )
    return {
      outcome: 'RECOVERED' as const,
      action: 'WAITING' as const,
      observedAt: pending.observedAt,
      cycle: pending.cycle,
    }
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
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'oldest unfinished mutation cycle read failed', cause, failure: 'store' }),
    ),
    Effect.map(Option.getOrUndefined),
  )

const mutationBound = (cycle: AutonomousCycle | undefined): cycle is AutonomousCycle =>
  cycle !== undefined && cycle.state === CycleState.Active && cycle.bindings.decisionHash !== undefined

const terminalizeUnboundMutationCycleAtCutoff = (
  cycle: AutonomousCycle,
  observedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  CycleStore.pipe(
    Effect.flatMap((store) => store.block(cycle.identity.cycleId, CycleTerminalReason.Authority, observedAt)),
    Effect.mapError((cause) =>
      mutationRunnerError({ message: 'expired PAPER unbound cycle finalization failed', cause, failure: 'store' }),
    ),
    Effect.map((receipt) => ({
      outcome: 'RECOVERED' as const,
      action: 'BLOCKED' as const,
      observedAt,
      cycle: receipt.cycle,
    })),
  )

const terminalizeBlockedPaperCycleDataFirst = (
  cycle: AutonomousCycle,
  outcome: Extract<BoundMutationCycleOutcome, { readonly _tag: 'Block' }>,
  authorityGenerationHash: string,
  blockedIntents: BlockedCycleIntentStoreShape,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore | AuthorityRestrictionStore | WriterFence> =>
  Effect.gen(function* () {
    const store = yield* CycleStore
    const restrictionStore = yield* AuthorityRestrictionStore
    const fence = yield* WriterFence
    const restrictionReason = `bound cycle ${cycle.identity.cycleId} blocked: ${outcome.reason}`
    const { cycleReceipt, intentReceipt } = yield* fence.transaction(
      store.block(cycle.identity.cycleId, outcome.reason, outcome.observedAt).pipe(
        Effect.mapError((cause) =>
          mutationRunnerError({ message: 'blocked PAPER cycle finalization failed', cause, failure: 'store' }),
        ),
        Effect.tap(() =>
          restrictionStore
            .restrictAuthority(
              `PAPER autonomous cycle loop restricted effective authority: ${restrictionReason}`,
              outcome.observedAt,
            )
            .pipe(
              Effect.mapError((cause) =>
                mutationRunnerError({
                  message: 'authority restriction failed after a bound PAPER cycle failure',
                  cause: { subject: 'PAPER autonomous cycle loop', reason: restrictionReason, cause },
                  failure: 'store',
                }),
              ),
            ),
        ),
        Effect.bindTo('cycleReceipt'),
        Effect.bind('intentReceipt', () =>
          blockedIntents
            .terminalizeUntouchedApproved({
              authorityGenerationHash,
              cycleId: cycle.identity.cycleId,
              observedAt: outcome.observedAt,
            })
            .pipe(
              Effect.mapError((cause) =>
                mutationRunnerError({
                  message: 'untouched approved intents could not be terminalized with their blocked PAPER cycle',
                  cause,
                  failure: 'store',
                }),
              ),
            ),
        ),
      ),
    )
    yield* Effect.logWarning('Bayn PAPER cycle terminalized with restricted mutation authority').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        cycleId: cycle.identity.cycleId,
        terminalReason: outcome.reason,
        blockedIntentCount: intentReceipt.blockedIntentCount,
        expiredIntentCount: intentReceipt.expiredIntentCount,
        terminalIntentCount: intentReceipt.terminalIntentCount,
        observedAt: outcome.observedAt,
      }),
    )
    return {
      outcome: 'RECOVERED' as const,
      action: 'BLOCKED' as const,
      observedAt: outcome.observedAt,
      cycle: cycleReceipt.cycle,
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof CycleRunnerError
        ? cause
        : mutationRunnerError({ message: 'blocked PAPER cycle transaction failed', cause, failure: 'store' }),
    ),
  )

export const terminalizeBlockedPaperCycle = terminalizeBlockedPaperCycleDataFirst

const interpretBoundMutationCycleOutcome = (
  input: ObserveAutonomousCycleInput,
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
      return input.blockedCycleIntentStore === undefined
        ? Effect.fail(
            mutationRunnerError({
              message: 'blocked PAPER cycle terminalization store is unavailable',
              failure: 'contract',
            }),
          )
        : terminalizeBlockedPaperCycle(cycle, outcome, input.authorityGenerationHash, input.blockedCycleIntentStore)
    case 'Complete':
      return CycleStore.pipe(
        Effect.flatMap((store) => store.finish(cycle.identity.cycleId, CycleState.Completed, outcome.observedAt)),
        Effect.mapError((cause) =>
          mutationRunnerError({ message: 'completed PAPER cycle finalization failed', cause, failure: 'store' }),
        ),
        Effect.tap((receipt) =>
          receipt.changed && input.onClosedCycle !== undefined
            ? input.onClosedCycle(cycle.identity.cycleId, outcome.observedAt)
            : Effect.void,
        ),
        Effect.map((receipt) => ({
          outcome: 'RECOVERED' as const,
          action: 'COMPLETED' as const,
          observedAt: outcome.observedAt,
          cycle: receipt.cycle,
        })),
      )
  }
}

const interpretBoundPaperCycleExecutionOutcome = (
  input: ObserveAutonomousCycleInput,
  outcome: BoundPaperCycleExecutionOutcome,
  cycle: AutonomousCycle,
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<RecoveryFirstCyclePassResult, CycleRunnerError, CycleStore | ObserveDecisionRuntime> => {
  if (outcome._tag === 'PostMutationReconciliation') {
    return Effect.succeed<RecoveryFirstCyclePassResult>(outcome)
  }
  return interpretBoundMutationCycleOutcome(input, outcome, cycle, context)
}

const recoverBoundMutationCycle = (
  input: ObserveAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  context: CycleRunContext<ObserveDecisionRuntime>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  capability: PaperExecutionCapability,
): Effect.Effect<RecoveryFirstCyclePassResult, CycleRunnerError, RecoveryFirstRuntime> =>
  readBoundMutationDocument(cycle).pipe(
    Effect.flatMap((document) =>
      document.mode === 'OBSERVE'
        ? runAutonomousCyclePass(context)
        : executeBoundPaperCycle(input, preparation, policy, cycle, document, reconcile, capability).pipe(
            Effect.flatMap((outcome) => interpretBoundPaperCycleExecutionOutcome(input, outcome, cycle, context)),
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
): Effect.Effect<RecoveryFirstCyclePassResult, CycleRunnerError, RecoveryFirstRuntime> =>
  readUnfinishedMutationCycle(context).pipe(
    Effect.flatMap((unfinished) => {
      if (mutationBound(unfinished)) {
        return recoverBoundMutationCycle(input, preparation, policy, unfinished, context, reconcile, capability)
      }
      return currentUtcInstant.pipe(
        Effect.flatMap((observedAt) => {
          if (
            input.paperEpisodeCutoffAt !== undefined &&
            observedAt >= input.paperEpisodeCutoffAt &&
            unfinished !== undefined
          ) {
            return terminalizeUnboundMutationCycleAtCutoff(unfinished, observedAt)
          }
          if (input.paperEpisodeCutoffAt !== undefined && observedAt >= input.paperEpisodeCutoffAt) {
            return Effect.succeed({ outcome: 'NO_PUBLICATION' as const, observedAt })
          }
          return runAutonomousCyclePass(context).pipe(
            Effect.flatMap((result) =>
              result.outcome === 'RECOVERED' && result.action === 'BOUND_DECISION'
                ? recoverBoundMutationCycle(input, preparation, policy, result.cycle, context, reconcile, capability)
                : Effect.succeed(result),
            ),
          )
        }),
      )
    }),
  )

const observeMutationPass = (
  startup: Parameters<AutonomousCycleStartup>[0],
  observation: CyclePassObservation,
): Effect.Effect<AutonomousCyclePassObservation> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return observePass(startup.recordPass, observation).pipe(
    Effect.tap(() => log.pipe(Effect.annotateLogs(facts.annotations))),
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

const reconcileMutationBeforeExternallyDrivenAdvance = (
  input: ObserveAutonomousCycleInput,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
): Effect.Effect<void, CycleRunnerError, ObserveDecisionRuntime> =>
  Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos
    const state = yield* Ref.get(cadence)
    const decision = decideIdleReconciliationCadence(state, nowNanos, input.reconciliationIntervalMs)
    if (decision._tag === 'RECONCILE') yield* attemptMutationIdleReconciliation(cadence, reconcile)
    else if (state.lastFailure !== undefined) return yield* state.lastFailure
  })

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
      if (state.lastFailure !== undefined) return yield* state.lastFailure
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
): Effect.Effect<AutonomousCyclePassObservation, never, ObserveDecisionRuntime> =>
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

const maintainMutationReconciliation = (
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

const waitAfterMutationFailure = maintainMutationReconciliation

const observeMutationCycleResult = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconcile: Effect.Effect<ReconciliationPassResult, ReconciliationPassError, ObserveDecisionRuntime>,
  result: CycleRunResult,
): Effect.Effect<AutonomousCyclePassObservation, never, ObserveDecisionRuntime> =>
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

export type RecoveryFirstCycleAdvance = {
  readonly observation: AutonomousCyclePassObservation
  readonly result?: CycleRunResult
}

export type RecoveryFirstCycleDriver = {
  readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, CycleRunnerError, RecoveryFirstRuntime>
  /** Keeps broker/accounting truth fresh while an external lifecycle owner is delayed between commands. */
  readonly maintainReconciliation: Effect.Effect<void, never, RecoveryFirstRuntime>
  /** The external owner must not delay the next command beyond either the cycle or reconciliation cadence. */
  readonly nextDelayMs: number
  readonly wait: (advance: RecoveryFirstCycleAdvance) => Effect.Effect<void, never, RecoveryFirstRuntime>
}

export type RecoveryFirstCycleDriverInterpreter = (
  driver: RecoveryFirstCycleDriver,
) => Effect.Effect<void, never, RecoveryFirstRuntime>

export const recoveryFirstCycleNextDelayMs = (input: {
  readonly pollIntervalMs: number
  readonly reconciliationIntervalMs: number
}): number => Math.min(input.pollIntervalMs, input.reconciliationIntervalMs)

const makeRecoveryFirstCycleDriver = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
  capability: PaperExecutionCapability,
  buildDecision: RecoveryFirstDecisionBuilder,
): Effect.Effect<RecoveryFirstCycleDriver, never, RecoveryFirstRuntime> =>
  Effect.gen(function* () {
    const cadence = yield* Ref.make<ReconciliationCadenceState>({})
    const operationPermit = yield* Semaphore.make(1)
    const cyclePassTimeoutMs = Math.min(input.reconciliationPassTimeoutMs, input.reconciliationIntervalMs)
    const reconcile = boundedReconciliationPass(input.reconciliationPassTimeoutMs).pipe(
      Effect.tap(() => markMutationReconciliationCompleted(cadence)),
    )
    const advanceCycle = Effect.gen(function* () {
      const context: CycleRunContext<ObserveDecisionRuntime> = {
        qualificationRunId: startup.qualificationRunId,
        ...(input.cycleCadence === undefined ? {} : { cadence: input.cycleCadence }),
        strategyProtocolHash: preparation.strategyProtocolHash,
        accountId: input.accountId,
        executionPolicy: preparation.executionPolicy,
        buildDecision: (cycle) => buildDecision(cycle, reconcile),
      }
      const result = yield* runMutationPassWithinTimeout(
        runRecoveryFirstCyclePass(input, preparation, policy, context, reconcile, capability),
        cyclePassTimeoutMs,
      )
      if (isPostMutationReconciliation(result)) {
        return yield* completePostMutationReconciliation(result, reconcile)
      }
      return result
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          (capability._tag === 'Mutation' ? restrictMutationLoopFailure(error) : Effect.void).pipe(
            Effect.catch((restrictionError: CycleRunnerError) =>
              currentUtcInstant.pipe(
                Effect.flatMap((observedAt) =>
                  observeMutationPass(startup, { outcome: 'FAILED', observedAt, error: restrictionError }),
                ),
                Effect.andThen(Effect.fail(restrictionError)),
              ),
            ),
            Effect.andThen(currentUtcInstant),
            Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
            Effect.map((observation) => ({ observation })),
          ),
        onSuccess: (result) =>
          observeMutationCycleResult(input, startup, cadence, reconcile, result).pipe(
            Effect.map((observation) => ({ observation, result })),
          ),
      }),
    )
    const runCycleAdvance =
      input.interpretCycleDriver === undefined
        ? advanceCycle
        : reconcileMutationBeforeExternallyDrivenAdvance(input, cadence, reconcile).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                currentUtcInstant.pipe(
                  Effect.flatMap((observedAt) =>
                    observeMutationPass(startup, { outcome: 'FAILED', observedAt, error }),
                  ),
                  Effect.map((observation) => ({ observation })),
                ),
              onSuccess: () => advanceCycle,
            }),
          )
    const advance = operationPermit.withPermit(
      input.beforeLifecycleAdvance === undefined
        ? runCycleAdvance
        : input.beforeLifecycleAdvance.pipe(
            Effect.flatMap((disposition) =>
              disposition === 'CONTINUE'
                ? runCycleAdvance
                : currentUtcInstant.pipe(
                    Effect.flatMap((observedAt) => {
                      const observation: AutonomousCyclePassObservation = {
                        result: 'SUCCESS',
                        observedAt,
                        outcome: 'RECOVERED',
                      }
                      return startup.recordPass(observation).pipe(Effect.as({ observation }))
                    }),
                  ),
            ),
          ),
    )
    const maintainReconciliation = operationPermit.withPermit(
      reconcileMutationBeforeExternallyDrivenAdvance(input, cadence, reconcile).pipe(
        Effect.catch((error) =>
          // Reconciliation persistence owns guardian readiness; do not replace Restate lifecycle progress.
          Effect.logError('Bayn Restate reconciliation guardian failed', error).pipe(
            Effect.annotateLogs({
              operation: error.operation,
              failure: error.failure,
              reason: error.message,
            }),
          ),
        ),
      ),
    )
    return {
      advance,
      maintainReconciliation,
      nextDelayMs: recoveryFirstCycleNextDelayMs(input),
      wait: (completed) =>
        completed.result === undefined
          ? waitAfterMutationFailure(input, startup, cadence, reconcile)
          : waitAfterMutationPass(input, startup, cadence, reconcile, completed.result),
    }
  })

export const interpretRecoveryFirstCycleInProcess: RecoveryFirstCycleDriverInterpreter = (driver) => {
  const run = (): Effect.Effect<void, never, RecoveryFirstRuntime> =>
    Effect.suspend(() =>
      driver.advance.pipe(
        Effect.flatMap(driver.wait),
        Effect.catch((restrictionError) => Effect.die(restrictionError)),
        Effect.andThen(run()),
      ),
    )
  return run()
}

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
      Result.map(() =>
        makeRecoveryFirstCycleDriver(input, startup, preparation, policy, capability, buildDecision).pipe(
          Effect.flatMap(input.interpretCycleDriver ?? interpretRecoveryFirstCycleInProcess),
        ),
      ),
    ),
    (cause) =>
      operationalError({
        component: 'strategy',
        operation: 'cycle-loop',
        message: `${operation} failed to start`,
        cause,
      }),
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
      const policy = yield* loadObserveRiskPolicy(
        input.accountId,
        strategyApplication(input.strategy).definition.parameters.universe,
      ).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'strategy',
            operation: 'risk-policy',
            message: 'source-controlled paper risk policy is invalid',
            cause,
          }),
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
      const policy = yield* loadObserveRiskPolicy(
        input.accountId,
        strategyApplication(input.strategy).definition.parameters.universe,
      ).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'strategy',
            operation: 'risk-policy',
            message: 'source-controlled paper risk policy is invalid',
            cause,
          }),
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
