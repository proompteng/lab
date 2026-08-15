import { Data, Duration, Effect, pipe, Result } from 'effect'
import type { AutonomousCycleStartup } from '../app'
import { BrokerRead, type BrokerReadShape, type MarketCalendarQuery } from '../broker/alpaca'
import { type AutonomousCycle } from '../cycle'
import {
  CycleDecisionBuildError,
  CycleRunnerError,
  marketCalendarQueryForSignal,
  type CyclePassObservation,
} from '../cycle/runner'
import { CycleNotDueReconciliationError } from '../cycle/runner/model'
import { retainAutonomousCyclePassObservation } from '../cycle/runner/pass-decisions'
import {
  bindCycleExecutionSession,
  type ExecutionSessionBinding,
  type ExecutionSessionBindingFailure,
} from '../execution-session'
import { makeFillTerms, MICROS } from '../execution-model'
import { OperationalError, operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { MarketData, type MarketDataService } from '../market-data'
import { executionMandateAllocationCapitalMicros } from '../execution/mandate'
import { Authority, OrderSide, OrderType, TimeInForce, type AuthorityState } from '../execution/contracts'
import type { CausalProtocol } from '../protocol'
import { runOnce, type ReconciliationPassResult } from '../reconciler'
import { reconciledStateHash } from '../reconciliation'
import { BrokerMode, decodePolicy, type Policy, type State } from '../risk'
import {
  buildObserveShadowDecision,
  buildExecutionDecision,
  type ShadowDecisionError,
  type ShadowDeltaRiskInput,
} from '../shadow-decision'
import type {
  CycleDecisionDocument,
  ObserveShadowDecisionDocument,
  ExecutionDecisionDocument,
} from '../shadow-decision-contract'
import { currentUtcInstant } from '../time'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import {
  planTargets,
  type SignalSessionReferencePrices,
  type TargetPlannerInput,
  type TargetPlannerFailure,
  type TargetPlanResult,
} from '../target-planner'
import { strategyApplication, type CompiledStrategyDecision, type StrategyRuntime } from '../strategy'
import type { DecisionPlan } from '../types'
import { mutationRunnerError } from './mutation-interpreter'
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

const loadObserveRiskPolicyDataFirst = (accountId: string, allowedSymbols: readonly string[]) =>
  decodePolicy({
    schemaVersion: 'bayn.paper-risk-policy.v2',
    accountId,
    brokerMode: BrokerMode.Execution,
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
    | 'execution-mandate-allocation'
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

export const decisionBuildError = (cause: ObserveDecisionFailure): CycleDecisionBuildError => {
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

export const notDueReconciliationError = (cause: ReconciliationPassError): CycleNotDueReconciliationError => {
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

export const prepareObserveDecisionReads = <R>(
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

export const readObserveDecisionFacts = <R>(
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
  authorityRequirement: Authority.Execution,
): Effect.Effect<ExecutionDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R>
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
      authorityRequirement === Authority.Execution
        ? yield* Effect.fromResult(
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
          ).pipe(
            Effect.mapError((cause) =>
              compositionFailure(
                'execution-mandate-allocation',
                'execution entry cannot fit its complete sell-plus-buy plan inside the remaining turnover budget',
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
        authorityRequirement === Authority.Execution && allocationCapitalMicros !== undefined
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
      : yield* buildExecutionDecision({
          ...decisionInput,
          authorityGenerationHash: input.authorityGenerationHash,
          executionSession,
        })
  })
}

export const buildMutationShadowCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
): Effect.Effect<ExecutionDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R> =>
  buildCycleDecision(input, Authority.Execution)

const makeClosingReferencePrices = (
  entryDocument: ExecutionDecisionDocument,
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

const recoverExecutionSession = (
  preparation: ObserveStartupPreparation,
  cycle: AutonomousCycle,
  entryDocument: ExecutionDecisionDocument,
): Result.Result<ExecutionSessionBinding, ObserveDecisionCompositionFailure> => {
  const bindRecoveredSession = (input: Parameters<typeof bindCycleExecutionSession>[0]) =>
    Result.mapError(bindCycleExecutionSession(input), (cause) =>
      compositionFailure('cycle-binding', 'execution-session binding does not match its cycle', cause),
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
      compositionFailure('cycle-binding', 'legacy execution close calendar material is not canonicalizable', cause),
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
): Effect.Effect<ExecutionDecisionDocument, CycleRunnerError, ObserveDecisionRuntime> => {
  const { input, preparation, policy, cycle, entryDocument, reconcile, closeExpiresAt, replanGenerationHash } = request
  return Effect.gen(function* () {
    const reconciliation = yield* reconcile.pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: 'execution close reconciliation failed', cause })),
    )
    const evaluatedAt = yield* currentUtcInstant
    const executionAuthority = yield* Effect.fromResult(
      requireMutationAuthorityGeneration(reconciliation, policy, input.authorityGenerationHash),
    ).pipe(Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })))
    const executionSession = yield* Effect.fromResult(recoverExecutionSession(preparation, cycle, entryDocument)).pipe(
      Effect.mapError((cause) => mutationRunnerError({ message: cause.message, cause, failure: 'contract' })),
    )
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
      hashObserveMaterial('risk-policy-hash', 'execution close risk policy is not canonicalizable', policy),
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
    return yield* buildExecutionDecision({
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
          message: 'deterministic execution close plan construction failed',
          cause: converted,
          failure: converted.failure,
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
