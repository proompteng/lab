import { Duration, Effect, Option, pipe, Result, Schedule } from 'effect'

import type { AutonomousCycleLoop, AutonomousCycleStartup } from './app'
import { BrokerRead, type BrokerReadShape, type MarketCalendarQuery } from './broker/alpaca'
import { CycleState, makeCycleExecutionPolicyFromModel, type AutonomousCycle, type CycleExecutionPolicy } from './cycle'
import {
  CycleDecisionBuildError,
  CycleRunnerError,
  cyclePassLogFacts,
  makeAutonomousCycleLoop,
  marketCalendarQueryForSignal,
  runAutonomousCyclePass,
  type CycleRunContext,
  type CyclePassObservation,
  type CycleRunResult,
} from './cycle-runner'
import { validateCycleLoopInterval } from './cycle-runner/decisions'
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
import { BrokerAccess, CapitalAuthorityKind } from './execution/authority'
import { IntentStore, planPaperIntent } from './execution/intents'
import { MutationEventType, MutationStore } from './execution/mutations'
import type { ExecutionProgram } from './execution/runtime-program'
import {
  bindCycleExecutionSession,
  type ExecutionSessionBinding,
  type ExecutionSessionBindingFailure,
} from './execution-session'
import { makeFillTerms, MICROS } from './execution-model'
import { makeStrategyProtocolHash } from './contracts'
import { operationalError, type OperationalError } from './errors'
import { canonicalHashV1Result } from './hash'
import { MarketData, type MarketDataService } from './market-data'
import {
  Authority,
  OrderSide,
  OrderType,
  RiskOutcome,
  TimeInForce,
  type AuthorityState,
  type Position,
} from './execution/contracts'
import type { CausalProtocol } from './protocol'
import { runOnce, type ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, decodePolicy, evaluate, type Policy, type State } from './risk'
import { buildObserveShadowDecision, type ShadowDecisionError, type ShadowDeltaRiskInput } from './shadow-decision'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'
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

type ReconciliationPassError = Effect.Error<typeof runOnce>

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

const projectShadowAuthority = (observation: ObserveAuthorityObservation): ObserveAuthorityObservation => ({
  // The durable shadow contract is deliberately OBSERVE-only and non-dispatchable. Mutation execution never
  // consumes this projected authority: it re-reads the same generation and requires exact PAPER authority
  // before constructing and committing executable intents.
  ...observation,
  authority: {
    ...observation.authority,
    maximum: Authority.Observe,
    effective: Authority.Observe,
  },
})

const buildCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
  authorityRequirement: DecisionAuthorityRequirement,
): Effect.Effect<ObserveShadowDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R> =>
  Effect.gen(function* () {
    const readPreparation = yield* Effect.fromResult(prepareObserveDecisionReads(input))
    const facts = yield* readObserveDecisionFacts(input, readPreparation)
    const executionAuthority = yield* Effect.fromResult(
      requireDecisionAuthority(facts.reconciliation, input.policy, input.authorityGenerationHash, authorityRequirement),
    )
    const shadowAuthority =
      authorityRequirement === Authority.Observe ? executionAuthority : projectShadowAuthority(executionAuthority)
    const executionSession = yield* Effect.fromResult(prepareExecutionSessionBinding(input, facts))
    const compiled = yield* compileObserveStrategyDecision(input, facts, executionSession)
    const plannerPreparation = yield* Effect.fromResult(prepareObservePlanner(input, facts, compiled))
    const targetPlan = yield* Effect.fromResult(planTargets(plannerPreparation.plannerInput))
    const riskInputs = yield* Effect.fromResult(
      reduceObserveRiskInputs(input, facts, shadowAuthority, executionSession, targetPlan, plannerPreparation.prices),
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

export const buildMutationShadowCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
): Effect.Effect<ObserveShadowDecisionDocument, ObserveDecisionFailure, BrokerRead | MarketData | R> =>
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

const makeObserveAutonomousLoop = (
  input: ObserveAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
): Result.Result<AutonomousCycleLoop<ObserveRuntime>, OperationalError> => {
  const context: CycleRunContext<ObserveDecisionRuntime> = {
    qualificationRunId: startup.qualificationRunId,
    strategyProtocolHash: preparation.strategyProtocolHash,
    accountId: input.accountId,
    executionPolicy: preparation.executionPolicy,
    buildDecision: (cycle) =>
      buildObserveCycleDecision({
        authorityGenerationHash: input.authorityGenerationHash,
        cycle,
        executionModel: preparation.executionModel,
        policy,
        reconcile: runOnce,
        strategy: input.strategy,
      }).pipe(Effect.mapError(decisionBuildError)),
  }
  return pipe(
    makeAutonomousCycleLoop({
      context: Effect.succeed(context),
      observePass: (observation) => observePass(startup.recordPass, observation),
      pollIntervalMs: input.pollIntervalMs,
    }),
    Result.mapError((cause) =>
      operationalError('strategy', 'cycle-loop', 'autonomous cycle loop failed to start', cause),
    ),
  )
}

export const makeObserveAutonomousCycleStartup =
  (input: ObserveAutonomousCycleInput): AutonomousCycleStartup<AuthorityGenerationStore, ObserveRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      const policy = yield* loadObserveRiskPolicy(input.accountId, input.strategy.parameters.universe).pipe(
        Effect.mapError((cause) =>
          operationalError('strategy', 'risk-policy', 'source-controlled paper risk policy is invalid', cause),
        ),
      )
      yield* initializeObserveAuthority(input)
      return yield* Effect.fromResult(makeObserveAutonomousLoop(input, startup, preparation, policy))
    })

const mutationConsistencyDelayMs = 1_000
const quantityScale = 1_000_000n

export type MutationAutonomousCycleInput = ObserveAutonomousCycleInput & {
  readonly executionProgram: ExecutionProgram
}

type MutationRuntime = ObserveRuntime | IntentStore | MutationStore

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

const validateBoundMutationDocument = (
  input: MutationAutonomousCycleInput,
  cycle: AutonomousCycle,
  policy: Policy,
  document: ObserveShadowDecisionDocument,
): Result.Result<void, CycleRunnerError> => {
  const policyHash = canonicalHashV1Result(policy)
  if (Result.isFailure(policyHash)) {
    return Result.fail(mutationRunnerError('mutation cycle risk policy is not canonicalizable', policyHash.failure))
  }
  return cycle.state !== CycleState.Active ||
    cycle.bindings.decisionHash !== document.contentHash ||
    cycle.bindings.snapshotId !== document.bindings.snapshotId ||
    cycle.identity.cycleId !== document.bindings.cycleId ||
    cycle.identity.accountId !== document.bindings.accountId ||
    cycle.identity.strategyProtocolHash !== document.bindings.strategyProtocolHash ||
    input.accountId !== document.bindings.accountId ||
    policyHash.success !== document.bindings.policyHash
    ? Result.fail(
        mutationRunnerError(
          'durable shadow plan does not match the mutation cycle account, protocol, policy, and decision binding',
          undefined,
          'contract',
        ),
      )
    : Result.succeed(undefined)
}

const readBoundMutationDocument = (
  cycle: AutonomousCycle,
): Effect.Effect<ObserveShadowDecisionDocument, CycleRunnerError, CycleStore> =>
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
  input: MutationAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
): ObserveDecisionInput<ObserveDecisionRuntime> => ({
  authorityGenerationHash: input.authorityGenerationHash,
  cycle,
  executionModel: preparation.executionModel,
  policy,
  reconcile: runOnce,
  strategy: input.strategy,
})

const prepareMutationIntents = (
  input: MutationAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
  document: ObserveShadowDecisionDocument,
): Effect.Effect<readonly string[], CycleRunnerError, ObserveDecisionRuntime | IntentStore> =>
  Effect.gen(function* () {
    yield* Effect.fromResult(validateBoundMutationDocument(input, cycle, policy, document))
    if (document.targetPlan.status !== TargetPlanStatus.Planned) return []

    const decisionInput = mutationDecisionInput(input, preparation, policy, cycle)
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
      requireDecisionAuthority(facts.reconciliation, policy, input.authorityGenerationHash, Authority.Paper),
    ).pipe(Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')))
    const executionSession = yield* Effect.fromResult(prepareExecutionSessionBinding(decisionInput, facts)).pipe(
      Effect.mapError((cause) => mutationRunnerError(cause.message, cause, 'contract')),
    )
    if (
      document.bindings.snapshotContentHash !== facts.snapshot.manifest.finalizedSnapshot.contentHash ||
      document.bindings.snapshotFinalizedAt !== facts.snapshot.manifest.finalizedSnapshot.finalizedAt
    ) {
      return yield* Effect.fail(
        mutationRunnerError('bound mutation cycle snapshot publication changed after planning', undefined, 'contract'),
      )
    }

    const intentStore = yield* IntentStore
    const targets = new Map(document.targetPlan.targets.map((target) => [target.symbol, target]))
    let reservedBuyingPower = 0n
    let dailyTradedNotional = BigInt(facts.reconciliation.riskContext.dailyTradedNotionalMicros)
    let projectedPositions: readonly Position[] = facts.reconciliation.brokerState.positions
    const intentIds: string[] = []

    for (const [index, targetIntent] of document.targetPlan.intentTargets.entries()) {
      const riskBinding = document.deltaRisk[index]
      const target = targets.get(targetIntent.symbol)
      if (riskBinding === undefined || target === undefined) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable mutation target is missing its risk or final-position binding',
            undefined,
            'contract',
          ),
        )
      }
      const fillTerms = yield* Effect.fromResult(
        makeFillTerms(
          targetIntent.side === OrderSide.Buy ? 'buy' : 'sell',
          BigInt(targetIntent.quantityMicros),
          BigInt(target.referencePriceMicros),
          preparation.executionModel,
          MICROS,
        ),
      ).pipe(Effect.mapError((cause) => mutationRunnerError('mutation execution terms are invalid', cause, 'contract')))
      if (fillTerms.notionalMicros.toString() !== riskBinding.notionalLimitMicros) {
        return yield* Effect.fail(
          mutationRunnerError(
            'durable mutation notional changed from its bound execution model',
            undefined,
            'contract',
          ),
        )
      }
      const state: State = {
        schemaVersion: 'bayn.paper-risk-state.v2',
        brokerMode: BrokerMode.Paper,
        account: facts.reconciliation.brokerState.account,
        positions: facts.reconciliation.brokerState.positions,
        positionsObservedAt: facts.reconciliation.brokerState.positionsObservedAt,
        orders: facts.reconciliation.brokerState.orders,
        ordersObservedAt: facts.reconciliation.brokerState.ordersObservedAt,
        reconciliation: facts.reconciliation.brokerState.reconciliation,
        authority: authority.authority,
        authorityObservedAt: authority.observedAt,
        unknownMutationCount: facts.reconciliation.riskContext.unknownMutationCount,
        dailyTradedNotionalMicros: dailyTradedNotional.toString(),
        dayStartEquityMicros: facts.reconciliation.riskContext.dayStartEquityMicros,
        peakEquityMicros: facts.reconciliation.riskContext.peakEquityMicros,
        accountingHash: facts.reconciliation.brokerState.accountingHash,
        marketDataSymbol: targetIntent.symbol,
        marketDataHash: document.bindings.snapshotContentHash,
        referencePriceMicros: target.referencePriceMicros,
        expectedExecutionPriceMicros: fillTerms.fillPriceMicros.toString(),
        marketDataObservedAt: facts.evaluatedAt,
        executionSession,
        reservedBuyingPowerMicros: reservedBuyingPower.toString(),
        evaluatedAt: facts.evaluatedAt,
      }
      const intent = yield* planPaperIntent(
        {
          schemaVersion: 'bayn.paper-intent-plan.v1',
          ...targetIntent,
          notionalLimitMicros: riskBinding.notionalLimitMicros,
          createdAt: document.createdAt,
        },
        state,
      ).pipe(Effect.mapError((cause) => mutationRunnerError('durable PAPER intent planning failed', cause, 'contract')))
      const stored = yield* intentStore
        .read(intent.intentId)
        .pipe(
          Effect.mapError((cause) => mutationRunnerError('durable PAPER intent recovery read failed', cause, 'store')),
        )
      const existing = Option.getOrUndefined(stored)
      const decision =
        existing?.decision === undefined
          ? yield* Effect.fromResult(evaluate(intent, state, policy, projectedPositions)).pipe(
              Effect.mapError((cause) => mutationRunnerError('PAPER intent risk evaluation failed', cause, 'contract')),
              Effect.flatMap((evaluation) =>
                evaluation.decision.outcome === RiskOutcome.Approved
                  ? Effect.succeed(evaluation.decision)
                  : Effect.fail(
                      mutationRunnerError(
                        `PAPER intent risk blocked execution: ${evaluation.decision.reasonCodes.join(',')}`,
                        evaluation,
                        'operational',
                      ),
                    ),
              ),
            )
          : existing.decision
      if (decision.outcome !== RiskOutcome.Approved) {
        return yield* Effect.fail(
          mutationRunnerError('recovered PAPER intent has a non-approved risk decision', decision, 'contract'),
        )
      }
      yield* intentStore
        .commit(intent, decision)
        .pipe(Effect.mapError((cause) => mutationRunnerError('durable PAPER intent commit failed', cause, 'store')))
      const orderNotional = fillTerms.notionalMicros
      reservedBuyingPower += targetIntent.side === OrderSide.Buy ? orderNotional : 0n
      dailyTradedNotional += orderNotional
      projectedPositions = projectMutationPosition(
        projectedPositions,
        target,
        input.accountId,
        facts.reconciliation.brokerState.positionsObservedAt,
      )
      intentIds.push(intent.intentId)
    }
    return intentIds
  })

const submitSucceeded = (eventType: MutationEventType): boolean =>
  eventType === MutationEventType.SubmitAccepted || eventType === MutationEventType.RecoveryFound

const submitTerminal = (eventType: MutationEventType): boolean =>
  submitSucceeded(eventType) || eventType === MutationEventType.SubmitRejected

const executeMutationIntent = (
  executionProgram: ExecutionProgram,
  intentId: string,
): Effect.Effect<void, CycleRunnerError, MutationStore> =>
  MutationStore.pipe(
    Effect.flatMap((store) => store.latest(intentId, MutationOperation.Submit)),
    Effect.mapError((cause) => mutationRunnerError('durable submit recovery read failed', cause, 'store')),
    Effect.flatMap((existing) =>
      (existing === undefined
        ? executionProgram.submit(intentId, mutationConsistencyDelayMs)
        : submitTerminal(existing.eventType)
          ? Effect.succeed(existing)
          : executionProgram.recover(intentId, MutationOperation.Submit)
      ).pipe(Effect.mapError((cause) => mutationRunnerError('guarded PAPER submit or recovery failed', cause))),
    ),
    Effect.flatMap((event) =>
      submitSucceeded(event.eventType)
        ? Effect.void
        : event.eventType === MutationEventType.SubmitRejected
          ? Effect.fail(mutationRunnerError('guarded PAPER submit was rejected by the broker', event, 'operational'))
          : Effect.fail(
              mutationRunnerError(
                `guarded PAPER submit remains unresolved at ${event.eventType}`,
                event,
                'operational',
              ),
            ),
    ),
  )

const executeBoundMutationCycle = (
  input: MutationAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  cycle: AutonomousCycle,
): Effect.Effect<void, CycleRunnerError, MutationRuntime> =>
  readBoundMutationDocument(cycle).pipe(
    Effect.flatMap((document) =>
      prepareMutationIntents(input, preparation, policy, cycle, document).pipe(
        Effect.flatMap((intentIds) =>
          Effect.forEach(intentIds, (intentId) => executeMutationIntent(input.executionProgram, intentId), {
            concurrency: 1,
            discard: true,
          }),
        ),
      ),
    ),
  )

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

const runMutationCyclePass = (
  input: MutationAutonomousCycleInput,
  preparation: ObserveStartupPreparation,
  policy: Policy,
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<CycleRunResult, CycleRunnerError, MutationRuntime> =>
  readUnfinishedMutationCycle(context).pipe(
    Effect.flatMap((unfinished) =>
      mutationBound(unfinished)
        ? executeBoundMutationCycle(input, preparation, policy, unfinished).pipe(
            Effect.andThen(runAutonomousCyclePass(context)),
          )
        : runAutonomousCyclePass(context).pipe(
            Effect.flatMap((result) =>
              result.outcome === 'RECOVERED' && result.action === 'BOUND_DECISION'
                ? executeBoundMutationCycle(input, preparation, policy, result.cycle).pipe(
                    Effect.andThen(runAutonomousCyclePass(context)),
                  )
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

const mutationCycleLoop = (
  input: MutationAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
  context: CycleRunContext<ObserveDecisionRuntime>,
): Effect.Effect<void, never, MutationRuntime> =>
  runMutationCyclePass(input, preparation, policy, context).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        currentUtcInstant.pipe(
          Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'FAILED', observedAt, error })),
        ),
      onSuccess: (result) =>
        currentUtcInstant.pipe(
          Effect.flatMap((observedAt) => observeMutationPass(startup, { outcome: 'SUCCEEDED', observedAt, result })),
        ),
    }),
    Effect.repeat(Schedule.spaced(Duration.millis(input.pollIntervalMs))),
    Effect.asVoid,
  )

const makeMutationAutonomousLoop = (
  input: MutationAutonomousCycleInput,
  startup: Parameters<AutonomousCycleStartup>[0],
  preparation: ObserveStartupPreparation,
  policy: Policy,
): Result.Result<AutonomousCycleLoop<MutationRuntime>, OperationalError> => {
  const context: CycleRunContext<ObserveDecisionRuntime> = {
    qualificationRunId: startup.qualificationRunId,
    strategyProtocolHash: preparation.strategyProtocolHash,
    accountId: input.accountId,
    executionPolicy: preparation.executionPolicy,
    buildDecision: (cycle) =>
      buildMutationShadowCycleDecision(mutationDecisionInput(input, preparation, policy, cycle)).pipe(
        Effect.mapError(decisionBuildError),
      ),
  }
  return Result.mapError(
    Result.map(validateCycleLoopInterval(input.pollIntervalMs), () =>
      mutationCycleLoop(input, startup, preparation, policy, context),
    ),
    (cause) => operationalError('strategy', 'cycle-loop', 'mutation autonomous cycle loop failed to start', cause),
  )
}

export const makeMutationAutonomousCycleStartup =
  (input: MutationAutonomousCycleInput): AutonomousCycleStartup<never, MutationRuntime> =>
  (startup) =>
    Effect.gen(function* () {
      const preparation = yield* Effect.fromResult(prepareObserveStartup(input))
      yield* Effect.fromResult(validateMutationExecutionProgram(input))
      const policy = yield* loadObserveRiskPolicy(input.accountId, input.strategy.parameters.universe).pipe(
        Effect.mapError((cause) =>
          operationalError('strategy', 'risk-policy', 'source-controlled paper risk policy is invalid', cause),
        ),
      )
      return yield* Effect.fromResult(makeMutationAutonomousLoop(input, startup, preparation, policy))
    })
