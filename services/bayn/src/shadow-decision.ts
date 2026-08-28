import { Data, Effect, Result, Schema } from 'effect'

import {
  AutonomousCycleSchema,
  CycleState,
  cycleAuthoritySessionDate,
  isIntradayAutonomousCycle,
  isLegacyAutonomousCycle,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
} from './cycle'
import {
  intentIdForPlan,
  clientOrderIdForIntentId,
  executionIntentIdForDecodedPlan,
  IntentPlanSchema,
  type IntentPlan,
} from './execution/intents/domain'
import type { ExecutionSessionBinding } from './execution-session'
import { canonicalHashV1Result } from './hash'
import {
  Authority,
  IntentSchema,
  IntentState,
  OrderSide,
  ReferenceIntentSchema,
  RiskOutcome,
  type Intent,
  type Position,
  type ReferenceIntent,
} from './execution/contracts'
import {
  legacyCycleDecisionSchemaVersion,
  legacyExecutionAuthorityToken,
  legacyExecutionIntentSchemaVersion,
  legacyIntentPlanSchemaVersion,
  legacyPositionSchemaVersion,
  legacyReferenceIntentSchemaVersion,
} from './execution/legacy-wire'
import { reconciledStateHash } from './reconciliation'
import { evaluate, isAuthorityNotGrantedReason, PolicySchema, StateSchema, type Policy, type State } from './risk'
import {
  ExecutionMarketDataBindingSchema,
  makeExecutionDecisionDocument,
  makeObserveShadowDecisionDocument,
  type CycleDecisionDocument,
  type DeltaRiskEvaluation,
  type ExecutionMarketDataBinding,
  type ObserveShadowDecisionDocument,
  type ExecutionDecisionDocument,
} from './shadow-decision-contract'
import {
  RuntimeStrategyDecisionSchema,
  runtimeDecisionMatchesStrategy,
  type RuntimeStrategyDecision,
} from './strategy/runtime-decision'
import {
  TargetPlannerInputSchema,
  TargetPlanResultSchema,
  TargetPlanStatus,
  type PlannedTargetQuantity,
  type TargetPlannerInput,
  type TargetPlanResult,
} from './target-planner'
import {
  PositiveMicrosSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'

export interface ShadowSnapshotBinding {
  readonly snapshotId: string
  readonly contentHash: string
  readonly finalizedAt: string
}

export interface ShadowDeltaRiskInput {
  readonly symbol: string
  readonly notionalLimitMicros: string
  readonly state: State
}

export interface ObserveShadowDecisionInput {
  readonly cycle: AutonomousCycle
  readonly snapshot: ShadowSnapshotBinding
  readonly compiledDecision: RuntimeStrategyDecision
  readonly executionMarketData?: ExecutionMarketDataBinding
  readonly plannerInput: TargetPlannerInput
  readonly targetPlan: TargetPlanResult
  readonly policy: Policy
  readonly riskInputs: readonly ShadowDeltaRiskInput[]
  readonly submissionCutoffAt?: string
}

export interface ExecutionDecisionInput extends ObserveShadowDecisionInput {
  readonly authorityGenerationHash: string
  /** The immutable signal/session binding retained for restart-safe close construction. */
  readonly executionSession: ExecutionSessionBinding
  /** A close-only plan uses the activation lease as its submission boundary. */
  readonly submissionCutoffAt?: string
  /** Residual close plans bind their intents to the preceding close-plan content hash. */
  readonly replanGenerationHash?: string
}

export class ShadowDecisionError extends Data.TaggedError('ShadowDecisionError')<{
  readonly failure: 'binding' | 'contract' | 'risk'
  readonly message: string
  readonly cause?: unknown
}> {}

const error = (failure: ShadowDecisionError['failure'], message: string, cause?: unknown): ShadowDecisionError =>
  new ShadowDecisionError({ failure, message, cause })

const ShadowSnapshotBindingSchema = Schema.Struct({
  snapshotId: Sha256Schema,
  contentHash: Sha256Schema,
  finalizedAt: UtcInstantSchema,
})

const ShadowDeltaRiskInputSchema = Schema.Struct({
  symbol: StrictNonEmptyStringSchema,
  notionalLimitMicros: PositiveMicrosSchema,
  state: StateSchema,
})

const ObserveShadowDecisionInputSchema = Schema.Struct({
  cycle: AutonomousCycleSchema,
  snapshot: ShadowSnapshotBindingSchema,
  compiledDecision: Schema.Unknown,
  executionMarketData: Schema.optionalKey(Schema.Unknown),
  plannerInput: TargetPlannerInputSchema,
  targetPlan: TargetPlanResultSchema,
  policy: PolicySchema,
  riskInputs: Schema.Array(ShadowDeltaRiskInputSchema),
  submissionCutoffAt: Schema.optional(UtcInstantSchema),
})

const decodeObserveShadowDecisionInputResult = Schema.decodeUnknownResult(
  ObserveShadowDecisionInputSchema,
  strictParseOptions,
)
const decodeRuntimeStrategyDecisionResult = Schema.decodeUnknownResult(
  RuntimeStrategyDecisionSchema,
  strictParseOptions,
)
const decodeExecutionMarketDataBindingResult = Schema.decodeUnknownResult(
  ExecutionMarketDataBindingSchema,
  strictParseOptions,
)
const decodeIntentPlanResult = Schema.decodeUnknownResult(IntentPlanSchema, strictParseOptions)
const decodeCumulativeStateResult = Schema.decodeUnknownResult(StateSchema, strictParseOptions)

const QUANTITY_SCALE = 1_000_000n
// Every micros value consumed by the pure reducer is schema-decoded before reaching these arithmetic helpers.
const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const divideAwayFromZero = (numerator: bigint): bigint => {
  const magnitude = absolute(numerator)
  const rounded = magnitude === 0n ? 0n : (magnitude + QUANTITY_SCALE - 1n) / QUANTITY_SCALE
  return numerator < 0n ? -rounded : rounded
}
const compareSymbols = (left: Position, right: Position): number => {
  if (left.symbol < right.symbol) return -1
  if (left.symbol > right.symbol) return 1
  return 0
}

const projectTargetPosition = (
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
    schemaVersion: legacyPositionSchemaVersion,
    accountId: previous?.accountId ?? accountId,
    symbol: target.symbol,
    quantityMicros: target.targetQuantityMicros,
    averageEntryPriceMicros: averageEntryPrice.toString(),
    marketPriceMicros: target.referencePriceMicros,
    marketValueMicros: divideAwayFromZero(quantity * referencePrice).toString(),
    unrealizedPnlMicros: divideAwayFromZero(quantity * (referencePrice - averageEntryPrice)).toString(),
    observedAt: previous?.observedAt ?? observedAt,
  }
  return [...retained, projected].sort(compareSymbols)
}

const revaluePositionAtReferencePrice = (position: Position, referencePriceMicros: string): Position => {
  const quantity = BigInt(position.quantityMicros)
  const referencePrice = BigInt(referencePriceMicros)
  const averageEntryPrice = BigInt(position.averageEntryPriceMicros)
  return {
    ...position,
    marketPriceMicros: referencePriceMicros,
    marketValueMicros: divideAwayFromZero(quantity * referencePrice).toString(),
    unrealizedPnlMicros: divideAwayFromZero(quantity * (referencePrice - averageEntryPrice)).toString(),
  }
}

const revalueInitialPositions = (
  positions: readonly Position[],
  referencePrices: Readonly<Record<string, string>>,
): Result.Result<readonly Position[], ShadowDecisionError> =>
  Result.all(
    positions.map((position) => {
      const referencePrice = referencePrices[position.symbol]
      return referencePrice === undefined
        ? Result.fail(error('binding', `held symbol ${position.symbol} has no target-planning reference price`))
        : Result.succeed(revaluePositionAtReferencePrice(position, referencePrice))
    }),
  ).pipe(Result.map((revalued) => revalued.sort(compareSymbols)))

const plannerBrokerStateMaterial = (input: TargetPlannerInput) => ({
  account: input.brokerState.account,
  positions: input.brokerState.positions,
  positionsObservedAt: input.brokerState.positionsObservedAt,
  orders: input.brokerState.orders,
  ordersObservedAt: input.brokerState.ordersObservedAt,
  accountingHash: input.brokerState.accountingHash,
})

const riskBrokerStateMaterial = (state: State) => ({
  account: state.account,
  positions: state.positions,
  positionsObservedAt: state.positionsObservedAt,
  orders: state.orders,
  ordersObservedAt: state.ordersObservedAt,
  accountingHash: state.accountingHash,
})

const hashValue = (
  value: unknown,
  failure: ShadowDecisionError['failure'],
  message: string,
): Result.Result<string, ShadowDecisionError> =>
  Result.mapError(canonicalHashV1Result(value), (cause) => error(failure, message, cause))

const compiledDecisionOf = (input: unknown): Result.Result<RuntimeStrategyDecision, ShadowDecisionError> =>
  Result.mapError(decodeRuntimeStrategyDecisionResult(input), (cause) =>
    error('contract', 'compiled strategy decision is invalid', cause),
  )

const validateBindings = (
  input: ObserveShadowDecisionInput,
  strategyDecisionHash: string,
  policyHash: string,
): Result.Result<void, ShadowDecisionError> => {
  const { cycle, plannerInput, snapshot } = input
  if (cycle.state !== CycleState.Active) {
    return Result.fail(error('binding', 'shadow planning requires an active autonomous cycle'))
  }
  if (
    (isLegacyAutonomousCycle(cycle) && cycle.bindings.snapshotId !== snapshot.snapshotId) ||
    (isIntradayAutonomousCycle(cycle) &&
      cycle.bindings.snapshotId !== undefined &&
      cycle.bindings.snapshotId !== snapshot.snapshotId)
  ) {
    return Result.fail(error('binding', 'shadow snapshot must match the immutable cycle snapshot binding'))
  }
  const submissionCutoffAt = input.submissionCutoffAt ?? cycle.window.submissionCutoffAt
  if (
    plannerInput.cycleId !== cycle.identity.cycleId ||
    plannerInput.strategyName !== cycle.identity.strategyName ||
    plannerInput.accountId !== cycle.identity.accountId ||
    plannerInput.signalDate !== cycleAuthoritySessionDate(cycle.identity) ||
    plannerInput.submissionCutoffAt !== submissionCutoffAt
  ) {
    return Result.fail(error('binding', 'target planner identity must match the active autonomous cycle'))
  }
  if (
    plannerInput.decisionHash !== strategyDecisionHash ||
    plannerInput.policyHash !== policyHash ||
    input.policy.accountId !== cycle.identity.accountId
  ) {
    return Result.fail(error('binding', 'target planner decision and policy must match the compiled shadow inputs'))
  }
  const decision = input.compiledDecision
  if (!runtimeDecisionMatchesStrategy(decision, cycle.identity.strategyName)) {
    return Result.fail(error('binding', 'compiled decision variant must match the immutable cycle strategy'))
  }
  const expectedDecisionSessionDate =
    decision.schemaVersion === 'bayn.risk-balanced-trend-decision-plan.v1'
      ? cycleAuthoritySessionDate(cycle.identity)
      : cycle.identity.executionSessionDate
  const decisionSessionDate =
    decision.schemaVersion === 'bayn.risk-balanced-trend-decision-plan.v1' ? decision.signalDate : decision.sessionDate
  if (decisionSessionDate !== expectedDecisionSessionDate) {
    return Result.fail(error('binding', 'compiled strategy decision must match the immutable cycle session'))
  }
  if (
    decision.schemaVersion === 'bayn.execution-flat-target.v1' &&
    (input.submissionCutoffAt === undefined ||
      input.submissionCutoffAt <= cycle.window.submissionCutoffAt ||
      input.riskInputs.some(
        ({ state }) => state.closeOnly !== true || state.closeOnlyExpiresAt !== input.submissionCutoffAt,
      ))
  ) {
    return Result.fail(error('binding', 'flat execution targets require the explicit bounded close-only lease'))
  }
  const intradayEntry =
    decision.schemaVersion === 'bayn.opening-drive.target.v1' ||
    decision.schemaVersion === 'bayn.intraday-momentum.target.v1'
  const intradayClose =
    decision.schemaVersion === 'bayn.execution-flat-target.v1' &&
    (decision.strategyName === 'opening-drive-momentum' || decision.strategyName === 'intraday-momentum')
  const intradayDecision = intradayEntry || intradayClose
  const executionMarketData = input.executionMarketData
  const executionCalendarSession = executionMarketData?.calendar.sessions.find(
    ({ date }) => date === cycle.identity.executionSessionDate,
  )
  const executionCalendar =
    executionMarketData === undefined || executionCalendarSession === undefined
      ? undefined
      : makeExecutionCalendarObservation({
          schemaVersion: executionMarketData.calendar.schemaVersion,
          source: executionMarketData.calendar.source,
          ...executionCalendarSession,
        })
  if (intradayEntry && decision.calendarHash !== cycle.window.executionCalendarHash) {
    return Result.fail(error('binding', 'intraday decision calendar must match the immutable cycle execution calendar'))
  }
  if (
    intradayDecision !== (executionMarketData !== undefined) ||
    (executionMarketData !== undefined && executionMarketData.sessionDate !== cycle.identity.executionSessionDate) ||
    (executionMarketData !== undefined &&
      (executionCalendar === undefined ||
        Result.isFailure(executionCalendar) ||
        executionCalendar.success.executionCalendarHash !== cycle.window.executionCalendarHash)) ||
    (intradayEntry && executionMarketData?.snapshotId !== decision.snapshotId)
  ) {
    return Result.fail(error('binding', 'execution market data must match the intraday strategy decision and cycle'))
  }
  const compiledWeightsHash = hashValue(
    input.compiledDecision.targetWeights,
    'contract',
    'compiled target weights are not canonicalizable',
  )
  if (Result.isFailure(compiledWeightsHash)) return Result.fail(compiledWeightsHash.failure)
  const plannedWeightsHash = hashValue(
    plannerInput.targetWeights,
    'contract',
    'planned target weights are not canonicalizable',
  )
  if (Result.isFailure(plannedWeightsHash)) return Result.fail(plannedWeightsHash.failure)
  if (compiledWeightsHash.success !== plannedWeightsHash.success) {
    return Result.fail(
      error('binding', 'compiled strategy decision must match the target planner weights and signal session'),
    )
  }
  if (plannerInput.observedAt < cycle.updatedAt) {
    return Result.fail(error('binding', 'shadow decision creation cannot precede the durable cycle state'))
  }
  return Result.succeed(undefined)
}

const validateRiskState = (
  input: ObserveShadowDecisionInput,
  riskInput: ShadowDeltaRiskInput,
  authority: Authority,
  commonExecutionSessionHash: string,
  plannerBrokerStateHash: string,
  plannerReconciliationHash: string,
): Result.Result<void, ShadowDecisionError> => {
  const { cycle, plannerInput, snapshot } = input
  const state = riskInput.state
  const authorityCompatible =
    state.closeOnly === true && authority === Authority.Execution
      ? state.authority.maximum === Authority.Execution &&
        (state.authority.effective === Authority.Execution || state.authority.effective === Authority.Observe)
      : state.authority.effective === authority
  if (!authorityCompatible) {
    return Result.fail(error('binding', `decision risk requires effective ${authority} authority`))
  }
  if (state.evaluatedAt !== plannerInput.observedAt) {
    return Result.fail(error('binding', 'shadow risk time must match target planning time'))
  }
  if (state.marketDataSymbol !== riskInput.symbol) {
    return Result.fail(error('binding', 'shadow risk market symbol must match its target delta'))
  }
  const decisionMarketDataHash = input.executionMarketData?.contentHash ?? snapshot.contentHash
  if (
    state.marketDataHash !== decisionMarketDataHash ||
    state.executionMarketDataHash !== input.executionMarketData?.contentHash
  ) {
    return Result.fail(error('binding', 'shadow risk data must match the bound decision market data'))
  }
  if (
    state.executionSession.schemaVersion === 'bayn.execution-session-binding.v1' ||
    state.executionSession.schemaVersion === 'bayn.execution-session-binding.v2'
  ) {
    if (
      !isLegacyAutonomousCycle(cycle) ||
      state.executionSession.signal.sessionDate !== cycle.identity.signalSessionDate ||
      state.executionSession.signal.finalizedAt !== snapshot.finalizedAt ||
      state.executionSession.signal.contentHash !== snapshot.contentHash
    ) {
      return Result.fail(error('binding', 'shadow risk signal binding must match the finalized cycle snapshot'))
    }
  } else if (!isIntradayAutonomousCycle(cycle) || input.executionMarketData === undefined) {
    return Result.fail(error('binding', 'shadow risk intraday binding must match the verified execution snapshot'))
  }
  if (
    state.executionSession.executionSession.date !== cycle.identity.executionSessionDate ||
    state.executionSession.executionSession.openAt !== cycle.window.executionOpenAt ||
    state.executionSession.executionSession.closeAt !== cycle.window.executionCloseAt ||
    state.executionSession.submissionCutoffAt !== cycle.window.submissionCutoffAt ||
    state.executionSession.submissionOpenAt < cycle.window.submissionOpenAt
  ) {
    return Result.fail(error('binding', 'shadow risk execution session must remain inside the immutable cycle window'))
  }
  if (state.executionSession.bindingHash !== commonExecutionSessionHash) {
    return Result.fail(error('binding', 'every target delta must use one execution-session binding'))
  }
  const plannedTarget = input.targetPlan.targets.find(({ symbol }) => symbol === riskInput.symbol)
  if (plannedTarget === undefined || state.referencePriceMicros !== plannedTarget.referencePriceMicros) {
    return Result.fail(
      error('binding', 'shadow risk must use the exact planned target price, account, and reconciliation state'),
    )
  }
  const riskStateHash = hashValue(
    riskBrokerStateMaterial(state),
    'contract',
    'shadow risk broker state is not canonicalizable',
  )
  if (Result.isFailure(riskStateHash)) return Result.fail(riskStateHash.failure)
  const riskReconciliationHash = hashValue(
    state.reconciliation,
    'contract',
    'shadow risk reconciliation is not canonicalizable',
  )
  if (Result.isFailure(riskReconciliationHash)) return Result.fail(riskReconciliationHash.failure)
  return riskStateHash.success === plannerBrokerStateHash &&
    riskReconciliationHash.success === plannerReconciliationHash
    ? Result.succeed(undefined)
    : Result.fail(
        error('binding', 'shadow risk must use the exact target-planning price, account, and reconciliation state'),
      )
}

const makeRiskIntent = (
  input: IntentPlan,
  authorityGenerationHash?: string,
): Result.Result<ReferenceIntent | Intent, ShadowDecisionError> => {
  const decodedPlan = Result.mapError(decodeIntentPlanResult(input), (cause) =>
    error('contract', 'shadow target delta could not form a valid risk intent', cause),
  )
  if (Result.isFailure(decodedPlan)) return Result.fail(decodedPlan.failure)
  const identityResult: Result.Result<string, ShadowDecisionError> =
    authorityGenerationHash === undefined
      ? Result.mapError(intentIdForPlan(decodedPlan.success), (cause) =>
          error('contract', 'shadow target delta identity is not canonicalizable', cause),
        )
      : Result.mapError(executionIntentIdForDecodedPlan(decodedPlan.success, authorityGenerationHash), (cause) =>
          error('contract', 'execution target delta identity is not canonicalizable', cause),
        )
  const identity = Result.mapError(
    Result.map(identityResult, (intentId) => ({
      intentId,
      clientOrderId: clientOrderIdForIntentId(intentId),
    })),
    (cause) => cause,
  )
  if (Result.isFailure(identity)) return Result.fail(identity.failure)
  const decoded = decodedPlan.success
  return Result.mapError(
    Schema.decodeUnknownResult(
      authorityGenerationHash === undefined ? ReferenceIntentSchema : IntentSchema,
      strictParseOptions,
    )({
      schemaVersion:
        authorityGenerationHash === undefined ? legacyReferenceIntentSchemaVersion : legacyExecutionIntentSchemaVersion,
      ...(authorityGenerationHash === undefined ? {} : { authorityGenerationHash }),
      intentId: identity.success.intentId,
      strategyName: decoded.strategyName,
      cycleId: decoded.cycleId,
      decisionHash: decoded.decisionHash,
      policyHash: decoded.policyHash,
      accountId: decoded.accountId,
      clientOrderId: identity.success.clientOrderId,
      symbol: decoded.symbol,
      side: decoded.side,
      orderType: decoded.orderType,
      timeInForce: decoded.timeInForce,
      quantityMicros: decoded.quantityMicros,
      notionalLimitMicros: decoded.notionalLimitMicros,
      ...(authorityGenerationHash === undefined || decoded.replanGenerationHash === undefined
        ? {}
        : { replanGenerationHash: decoded.replanGenerationHash }),
      state: IntentState.Planned,
      createdAt: decoded.createdAt,
    }),
    (cause) => error('contract', 'shadow target delta could not form a valid risk intent', cause),
  )
}

interface ShadowReduction {
  readonly reservedBuyingPower: bigint
  readonly dailyTradedNotional: bigint
  readonly projectedPositions: readonly Position[]
  readonly deltaRisk: readonly DeltaRiskEvaluation[]
  readonly riskBlock?: NonNullable<ExecutionDecisionDocument['riskBlock']>
}

interface ShadowReductionContext {
  readonly input: ObserveShadowDecisionInput
  readonly policyHash: string
  readonly riskInputs: ReadonlyMap<string, ShadowDeltaRiskInput>
  readonly targetsBySymbol: ReadonlyMap<string, PlannedTargetQuantity>
  readonly authority: Authority
  readonly authorityGenerationHash?: string
  readonly replanGenerationHash?: string
}

const reduceShadowDelta = (
  accumulator: ShadowReduction,
  targetIntent: TargetPlanResult['intentTargets'][number],
  context: ShadowReductionContext,
): Result.Result<ShadowReduction, ShadowDecisionError> => {
  const provided = context.riskInputs.get(targetIntent.symbol)
  if (provided === undefined) {
    return Result.fail(error('binding', 'planned target delta is missing its risk input'))
  }
  const intent = makeRiskIntent(
    {
      schemaVersion: legacyIntentPlanSchemaVersion,
      ...targetIntent,
      notionalLimitMicros: provided.notionalLimitMicros,
      ...(context.replanGenerationHash === undefined ? {} : { replanGenerationHash: context.replanGenerationHash }),
    },
    context.authorityGenerationHash,
  )
  if (Result.isFailure(intent)) return Result.fail(intent.failure)
  const state = Result.mapError(
    decodeCumulativeStateResult({
      ...provided.state,
      reservedBuyingPowerMicros: accumulator.reservedBuyingPower.toString(),
      dailyTradedNotionalMicros: accumulator.dailyTradedNotional.toString(),
    }),
    (cause) => error('contract', 'cumulative shadow risk state is invalid', cause),
  )
  if (Result.isFailure(state)) return Result.fail(state.failure)
  const evaluation = evaluate({
    intent: intent.success,
    state: state.success,
    policy: context.input.policy,
    proposedPositions: accumulator.projectedPositions,
  })
  if (Result.isFailure(evaluation)) {
    return Result.fail(error('risk', 'shadow target risk evaluation failed', evaluation.failure))
  }
  const validOutcome =
    context.authority === Authority.Observe
      ? evaluation.success.decision.outcome === RiskOutcome.Blocked &&
        evaluation.success.decision.reasonCodes.some(isAuthorityNotGrantedReason)
      : evaluation.success.decision.outcome === RiskOutcome.Approved ||
        evaluation.success.decision.outcome === RiskOutcome.Blocked
  if (evaluation.success.policyHash !== context.policyHash || !validOutcome) {
    return Result.fail(error('risk', `${context.authority} decision risk outcome is incompatible with authority`))
  }
  const target = context.targetsBySymbol.get(targetIntent.symbol)
  if (target === undefined) {
    return Result.fail(error('contract', 'planned target delta is missing its final quantity'))
  }
  const orderNotional = BigInt(evaluation.success.metrics.orderNotionalMicros)
  const deltaRisk = [
    ...accumulator.deltaRisk,
    {
      notionalLimitMicros: provided.notionalLimitMicros,
      evaluation: evaluation.success,
    },
  ]
  if (context.authority === Authority.Execution && evaluation.success.decision.outcome === RiskOutcome.Blocked) {
    return Result.succeed({
      ...accumulator,
      deltaRisk,
      riskBlock: {
        intentId: evaluation.success.decision.intentId,
        decisionId: evaluation.success.decision.decisionId,
        reasonCodes: evaluation.success.decision.reasonCodes,
      },
    })
  }
  return Result.succeed({
    reservedBuyingPower: accumulator.reservedBuyingPower + (targetIntent.side === OrderSide.Buy ? orderNotional : 0n),
    dailyTradedNotional: accumulator.dailyTradedNotional + orderNotional,
    projectedPositions: projectTargetPosition(
      accumulator.projectedPositions,
      target,
      context.input.plannerInput.accountId,
      provided.state.positionsObservedAt,
    ),
    deltaRisk,
  })
}

interface ShadowDecisionContext {
  readonly input: ObserveShadowDecisionInput
  readonly strategyDecisionHash: string
  readonly policyHash: string
}

interface PreparedShadowRisk {
  readonly input: ObserveShadowDecisionInput
  readonly policyHash: string
  readonly riskInputs: ReadonlyMap<string, ShadowDeltaRiskInput>
  readonly targetsBySymbol: ReadonlyMap<string, PlannedTargetQuantity>
  readonly baseReservedBuyingPower: string
  readonly baseDailyTradedNotional: string
  readonly initialPositions: readonly Position[]
}

const decodeShadowDecisionContext = (
  inputValue: unknown,
): Result.Result<ShadowDecisionContext, ShadowDecisionError> => {
  const decoded = Result.mapError(decodeObserveShadowDecisionInputResult(inputValue), (cause) =>
    error('contract', 'shadow decision input failed its domain contract', cause),
  )
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  const compiledDecision = compiledDecisionOf(decoded.success.compiledDecision)
  if (Result.isFailure(compiledDecision)) return Result.fail(compiledDecision.failure)
  const executionMarketData =
    decoded.success.executionMarketData === undefined
      ? Result.succeed(undefined)
      : Result.mapError(decodeExecutionMarketDataBindingResult(decoded.success.executionMarketData), (cause) =>
          error('contract', 'execution market-data binding is invalid', cause),
        )
  if (Result.isFailure(executionMarketData)) return Result.fail(executionMarketData.failure)
  const { submissionCutoffAt, executionMarketData: _, ...decodedInput } = decoded.success
  const input: ObserveShadowDecisionInput = {
    ...decodedInput,
    compiledDecision: compiledDecision.success,
    ...(executionMarketData.success === undefined ? {} : { executionMarketData: executionMarketData.success }),
    ...(submissionCutoffAt === undefined ? {} : { submissionCutoffAt }),
  }
  const strategyDecisionHash = hashValue(
    input.compiledDecision,
    'contract',
    'compiled strategy decision is not canonicalizable',
  )
  if (Result.isFailure(strategyDecisionHash)) return Result.fail(strategyDecisionHash.failure)
  const policyHash = hashValue(input.policy, 'contract', 'shadow risk policy is not canonicalizable')
  if (Result.isFailure(policyHash)) return Result.fail(policyHash.failure)
  return Result.succeed({
    input,
    strategyDecisionHash: strategyDecisionHash.success,
    policyHash: policyHash.success,
  })
}

const validateShadowPlanningBindings = (context: ShadowDecisionContext): Result.Result<void, ShadowDecisionError> => {
  const { input, policyHash, strategyDecisionHash } = context
  const binding = validateBindings(input, strategyDecisionHash, policyHash)
  if (Result.isFailure(binding)) return Result.fail(binding.failure)
  const plannerInputHash = hashValue(input.plannerInput, 'contract', 'target planner input is not canonicalizable')
  if (Result.isFailure(plannerInputHash)) return Result.fail(plannerInputHash.failure)
  if (input.targetPlan.inputHash !== plannerInputHash.success) {
    return Result.fail(error('binding', 'target plan must match the exact planner input'))
  }
  if (input.targetPlan.status !== TargetPlanStatus.Planned && input.riskInputs.length !== 0) {
    return Result.fail(error('binding', 'NO_TRADE and BLOCKED target plans cannot retain ignored risk inputs'))
  }
  if (
    input.targetPlan.status === TargetPlanStatus.Planned &&
    input.targetPlan.intentTargets.length !== input.riskInputs.length
  ) {
    return Result.fail(error('binding', 'planned target deltas require exactly one risk input per symbol'))
  }
  return Result.succeed(undefined)
}

const prepareShadowRisk = (context: ShadowDecisionContext): Result.Result<PreparedShadowRisk, ShadowDecisionError> => {
  const { input } = context
  const riskInputs = new Map(input.riskInputs.map((riskInput) => [riskInput.symbol, riskInput]))
  if (riskInputs.size !== input.riskInputs.length) {
    return Result.fail(error('binding', 'shadow risk inputs must contain unique symbols'))
  }
  const firstRiskInput = input.riskInputs[0]
  const baseReservedBuyingPower = firstRiskInput?.state.reservedBuyingPowerMicros ?? '0'
  const baseDailyTradedNotional = firstRiskInput?.state.dailyTradedNotionalMicros ?? '0'
  const commonExecutionSessionHash = firstRiskInput?.state.executionSession.bindingHash ?? ''
  const plannerBrokerStateHash = hashValue(
    plannerBrokerStateMaterial(input.plannerInput),
    'contract',
    'target-planning broker state is not canonicalizable',
  )
  if (Result.isFailure(plannerBrokerStateHash)) return Result.fail(plannerBrokerStateHash.failure)
  const plannerReconciliationHash = hashValue(
    input.plannerInput.brokerState.reconciliation,
    'contract',
    'target-planning reconciliation is not canonicalizable',
  )
  if (Result.isFailure(plannerReconciliationHash)) return Result.fail(plannerReconciliationHash.failure)

  for (const candidate of input.riskInputs) {
    if (
      candidate.state.reservedBuyingPowerMicros !== baseReservedBuyingPower ||
      candidate.state.dailyTradedNotionalMicros !== baseDailyTradedNotional
    ) {
      return Result.fail(
        error('binding', 'every shadow risk input must start from one reservation and daily-notional state'),
      )
    }
    const stateValidation = validateRiskState(
      input,
      candidate,
      firstRiskInput?.state.authority.effective ?? Authority.Observe,
      commonExecutionSessionHash,
      plannerBrokerStateHash.success,
      plannerReconciliationHash.success,
    )
    if (Result.isFailure(stateValidation)) return Result.fail(stateValidation.failure)
  }

  const targetsBySymbol = new Map(input.targetPlan.targets.map((target) => [target.symbol, target]))
  let initialPositions: readonly Position[] = []
  if (input.targetPlan.status === TargetPlanStatus.Planned) {
    const revalued = revalueInitialPositions(
      firstRiskInput?.state.positions ?? input.plannerInput.brokerState.positions,
      input.plannerInput.referencePrices.priceMicros,
    )
    if (Result.isFailure(revalued)) return Result.fail(revalued.failure)
    initialPositions = revalued.success
  }
  return Result.succeed({
    input,
    policyHash: context.policyHash,
    riskInputs,
    targetsBySymbol,
    baseReservedBuyingPower,
    baseDailyTradedNotional,
    initialPositions,
  })
}

const reduceShadowRisk = (
  prepared: PreparedShadowRisk,
  authority: Authority,
  authorityGenerationHash?: string,
  replanGenerationHash?: string,
): Result.Result<ShadowReduction, ShadowDecisionError> =>
  prepared.input.targetPlan.intentTargets.reduce<Result.Result<ShadowReduction, ShadowDecisionError>>(
    (accumulator, targetIntent) =>
      Result.flatMap(accumulator, (state) =>
        state.riskBlock !== undefined
          ? Result.succeed(state)
          : reduceShadowDelta(state, targetIntent, {
              input: prepared.input,
              policyHash: prepared.policyHash,
              riskInputs: prepared.riskInputs,
              targetsBySymbol: prepared.targetsBySymbol,
              authority,
              ...(authorityGenerationHash === undefined ? {} : { authorityGenerationHash }),
              ...(replanGenerationHash === undefined ? {} : { replanGenerationHash }),
            }),
      ),
    Result.succeed({
      reservedBuyingPower: BigInt(prepared.baseReservedBuyingPower),
      dailyTradedNotional: BigInt(prepared.baseDailyTradedNotional),
      projectedPositions: prepared.initialPositions,
      deltaRisk: [],
    }),
  )

const assembleShadowDecisionDocument = (
  context: ShadowDecisionContext,
  reduction: ShadowReduction,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionError> => {
  const { input, policyHash, strategyDecisionHash } = context
  const planningBrokerStateHash = Result.mapError(
    reconciledStateHash(plannerBrokerStateMaterial(input.plannerInput)),
    (cause) => error('contract', 'planning broker state hash could not be derived', cause),
  )
  if (Result.isFailure(planningBrokerStateHash)) return Result.fail(planningBrokerStateHash.failure)
  const document = Result.mapError(
    makeObserveShadowDecisionDocument({
      schemaVersion: 'bayn.observe-shadow-decision.v1',
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        strategyName: input.plannerInput.strategyName,
        cycleId: input.cycle.identity.cycleId,
        strategyProtocolHash: input.cycle.identity.strategyProtocolHash,
        snapshotId: input.snapshot.snapshotId,
        snapshotContentHash: input.snapshot.contentHash,
        snapshotFinalizedAt: input.snapshot.finalizedAt,
        strategyDecisionHash,
        policyHash,
        accountId: input.plannerInput.accountId,
        planningBrokerStateHash: planningBrokerStateHash.success,
        reconciliationId: input.plannerInput.brokerState.reconciliation.reconciliationId,
        reconciliationHash: input.plannerInput.brokerState.reconciliation.contentHash,
        ...(input.executionMarketData === undefined ? {} : { executionMarketData: input.executionMarketData }),
      },
      targetPlan: input.targetPlan,
      deltaRisk: reduction.deltaRisk,
      submissionCutoffAt: input.cycle.window.submissionCutoffAt,
      expiresAt: input.cycle.window.submissionCutoffAt,
      createdAt: input.plannerInput.observedAt,
    }),
    (cause) => error('contract', 'shadow decision document failed durable contract validation', cause),
  )
  if (Result.isFailure(document)) return Result.fail(document.failure)
  if (
    input.cycle.bindings.decisionHash !== undefined &&
    input.cycle.bindings.decisionHash !== document.success.contentHash
  ) {
    return Result.fail(error('binding', 'shadow document must match the immutable cycle decision binding'))
  }
  return document
}

const reduceObserveShadowDecision = (
  inputValue: unknown,
): Result.Result<ObserveShadowDecisionDocument, ShadowDecisionError> =>
  Result.flatMap(decodeShadowDecisionContext(inputValue), (context) =>
    Result.flatMap(validateShadowPlanningBindings(context), () =>
      Result.flatMap(prepareShadowRisk(context), (prepared) =>
        Result.flatMap(reduceShadowRisk(prepared, Authority.Observe), (reduction) =>
          assembleShadowDecisionDocument(context, reduction),
        ),
      ),
    ),
  )

export const buildObserveShadowDecision = (
  input: unknown,
): Effect.Effect<ObserveShadowDecisionDocument, ShadowDecisionError> =>
  Effect.fromResult(reduceObserveShadowDecision(input))

const assembleExecutionDecisionDocument = (
  context: ShadowDecisionContext,
  reduction: ShadowReduction,
  authorityGenerationHash: string,
  executionSession: ExecutionSessionBinding,
  submissionCutoffAt: string,
  replanGenerationHash?: string,
): Result.Result<ExecutionDecisionDocument, ShadowDecisionError> => {
  const { input, policyHash, strategyDecisionHash } = context
  const planningBrokerStateHash = Result.mapError(
    reconciledStateHash(plannerBrokerStateMaterial(input.plannerInput)),
    (cause) => error('contract', 'planning broker state hash could not be derived', cause),
  )
  if (Result.isFailure(planningBrokerStateHash)) return Result.fail(planningBrokerStateHash.failure)
  return Result.mapError(
    makeExecutionDecisionDocument({
      schemaVersion: legacyCycleDecisionSchemaVersion,
      mode: legacyExecutionAuthorityToken,
      dispatchable: reduction.riskBlock === undefined,
      bindings: {
        strategyName: input.plannerInput.strategyName,
        cycleId: input.cycle.identity.cycleId,
        qualificationRunId: input.cycle.identity.qualificationRunId,
        strategyProtocolHash: input.cycle.identity.strategyProtocolHash,
        snapshotId: input.snapshot.snapshotId,
        snapshotContentHash: input.snapshot.contentHash,
        snapshotFinalizedAt: input.snapshot.finalizedAt,
        strategyDecisionHash,
        policyHash,
        accountId: input.plannerInput.accountId,
        planningBrokerStateHash: planningBrokerStateHash.success,
        reconciliationId: input.plannerInput.brokerState.reconciliation.reconciliationId,
        reconciliationHash: input.plannerInput.brokerState.reconciliation.contentHash,
        authorityGenerationHash,
        ...(input.executionMarketData === undefined ? {} : { executionMarketData: input.executionMarketData }),
      },
      executionSession,
      targetPlan: input.targetPlan,
      deltaRisk: reduction.deltaRisk,
      orderedIntentIds: reduction.deltaRisk.map((risk) => risk.evaluation.input.intentId),
      ...(reduction.riskBlock === undefined ? {} : { riskBlock: reduction.riskBlock }),
      ...(replanGenerationHash === undefined ? {} : { replanGenerationHash }),
      submissionCutoffAt,
      expiresAt: submissionCutoffAt,
      createdAt: input.plannerInput.observedAt,
    }),
    (cause) => error('contract', 'execution decision document failed durable contract validation', cause),
  )
}

export const buildExecutionDecision = (
  input: ExecutionDecisionInput,
): Effect.Effect<ExecutionDecisionDocument, ShadowDecisionError> =>
  Effect.fromResult(
    Result.flatMap(
      decodeShadowDecisionContext({
        cycle: input.cycle,
        snapshot: input.snapshot,
        compiledDecision: input.compiledDecision,
        ...(input.executionMarketData === undefined ? {} : { executionMarketData: input.executionMarketData }),
        plannerInput: input.plannerInput,
        targetPlan: input.targetPlan,
        policy: input.policy,
        riskInputs: input.riskInputs,
        ...(input.submissionCutoffAt === undefined ? {} : { submissionCutoffAt: input.submissionCutoffAt }),
      }),
      (context) =>
        Result.flatMap(validateShadowPlanningBindings(context), () =>
          Result.flatMap(prepareShadowRisk(context), (prepared) =>
            Result.flatMap(
              reduceShadowRisk(
                prepared,
                Authority.Execution,
                input.authorityGenerationHash,
                input.replanGenerationHash,
              ),
              (reduction) =>
                assembleExecutionDecisionDocument(
                  context,
                  reduction,
                  input.authorityGenerationHash,
                  input.executionSession,
                  input.submissionCutoffAt ?? input.cycle.window.submissionCutoffAt,
                  input.replanGenerationHash,
                ),
            ),
          ),
        ),
    ),
  )

export type DurableCycleDecisionDocument = CycleDecisionDocument
