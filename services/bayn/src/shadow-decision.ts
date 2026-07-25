import { Buffer } from 'node:buffer'

import { Data, Effect, Result, Schema } from 'effect'

import { AutonomousCycleSchema, CycleState, type AutonomousCycle } from './cycle'
import { DecisionPlanSchema, type DecisionPlan } from './evidence-contracts'
import { intentIdForPlan, IntentPlanSchema, type IntentPlan } from './execution/intents'
import { canonicalHashV1 } from './hash'
import {
  Authority,
  IntentState,
  OrderSide,
  ReferenceIntentSchema,
  RiskOutcome,
  type Position,
  type ReferenceIntent,
} from './paper'
import { reconciledStateHash } from './reconciliation'
import { evaluate, PolicySchema, Reason, StateSchema, type Policy, type State } from './risk'
import {
  makeObserveShadowDecisionDocument,
  type DeltaRiskEvaluation,
  type ObserveShadowDecisionDocument,
} from './shadow-decision-contract'
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
  readonly compiledDecision: DecisionPlan
  readonly plannerInput: TargetPlannerInput
  readonly targetPlan: TargetPlanResult
  readonly policy: Policy
  readonly riskInputs: readonly ShadowDeltaRiskInput[]
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
  plannerInput: TargetPlannerInputSchema,
  targetPlan: TargetPlanResultSchema,
  policy: PolicySchema,
  riskInputs: Schema.Array(ShadowDeltaRiskInputSchema),
})

const decodeObserveShadowDecisionInputResult = Schema.decodeUnknownResult(
  ObserveShadowDecisionInputSchema,
  strictParseOptions,
)
const decodeDecisionPlanResult = Schema.decodeUnknownResult(DecisionPlanSchema, strictParseOptions)
const decodeIntentPlanResult = Schema.decodeUnknownResult(IntentPlanSchema, strictParseOptions)
const decodeReferenceIntentResult = Schema.decodeUnknownResult(ReferenceIntentSchema, strictParseOptions)
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
  return [...retained, projected].sort(compareSymbols)
}

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
  Result.mapError(Result.try({ try: () => canonicalHashV1(value), catch: (cause) => cause }), (cause) =>
    error(failure, message, cause),
  )

const compiledDecisionOf = (input: unknown): Result.Result<DecisionPlan, ShadowDecisionError> =>
  Result.mapError(decodeDecisionPlanResult(input), (cause) =>
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
  if (cycle.bindings.snapshotId !== snapshot.snapshotId) {
    return Result.fail(error('binding', 'shadow snapshot must match the immutable cycle snapshot binding'))
  }
  if (
    plannerInput.cycleId !== cycle.identity.cycleId ||
    plannerInput.strategyName !== cycle.identity.strategyName ||
    plannerInput.accountId !== cycle.identity.accountId ||
    plannerInput.signalDate !== cycle.identity.signalSessionDate ||
    plannerInput.submissionCutoffAt !== cycle.window.submissionCutoffAt
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
  if (input.compiledDecision.signalDate !== plannerInput.signalDate) {
    return Result.fail(
      error('binding', 'compiled strategy decision must match the target planner weights and signal session'),
    )
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
  commonExecutionSessionHash: string,
  plannerBrokerStateHash: string,
  plannerReconciliationHash: string,
): Result.Result<void, ShadowDecisionError> => {
  const { cycle, plannerInput, snapshot } = input
  const state = riskInput.state
  if (state.authority.effective !== Authority.Observe) {
    return Result.fail(error('binding', 'shadow risk requires effective OBSERVE authority'))
  }
  if (state.evaluatedAt !== plannerInput.observedAt) {
    return Result.fail(error('binding', 'shadow risk time must match target planning time'))
  }
  if (state.marketDataSymbol !== riskInput.symbol) {
    return Result.fail(error('binding', 'shadow risk market symbol must match its target delta'))
  }
  if (state.marketDataHash !== snapshot.contentHash) {
    return Result.fail(error('binding', 'shadow risk data must match the finalized snapshot content'))
  }
  if (
    state.executionSession.signal.sessionDate !== cycle.identity.signalSessionDate ||
    state.executionSession.signal.finalizedAt !== snapshot.finalizedAt ||
    state.executionSession.signal.contentHash !== snapshot.contentHash
  ) {
    return Result.fail(error('binding', 'shadow risk signal binding must match the finalized cycle snapshot'))
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
  if (state.referencePriceMicros !== plannerInput.referencePrices.priceMicros[riskInput.symbol]) {
    return Result.fail(
      error('binding', 'shadow risk must use the exact target-planning price, account, and reconciliation state'),
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

const makeReferenceIntent = (input: IntentPlan): Result.Result<ReferenceIntent, ShadowDecisionError> => {
  const decodedPlan = Result.mapError(decodeIntentPlanResult(input), (cause) =>
    error('contract', 'shadow target delta could not form a valid risk intent', cause),
  )
  if (Result.isFailure(decodedPlan)) return Result.fail(decodedPlan.failure)
  const identity = Result.try({
    try: () => {
      const intentId = intentIdForPlan(decodedPlan.success)
      return {
        intentId,
        clientOrderId: `b1_${Buffer.from(intentId, 'hex').toString('base64url')}`,
      }
    },
    catch: (cause) => error('contract', 'shadow target delta identity is not canonicalizable', cause),
  })
  if (Result.isFailure(identity)) return Result.fail(identity.failure)
  const decoded = decodedPlan.success
  return Result.mapError(
    decodeReferenceIntentResult({
      schemaVersion: 'bayn.paper-intent.v2',
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
}

interface ShadowReductionContext {
  readonly input: ObserveShadowDecisionInput
  readonly policyHash: string
  readonly riskInputs: ReadonlyMap<string, ShadowDeltaRiskInput>
  readonly targetsBySymbol: ReadonlyMap<string, PlannedTargetQuantity>
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
  const intent = makeReferenceIntent({
    schemaVersion: 'bayn.paper-intent-plan.v1',
    ...targetIntent,
    notionalLimitMicros: provided.notionalLimitMicros,
  })
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
  const evaluation = evaluate(intent.success, state.success, context.input.policy, accumulator.projectedPositions)
  if (Result.isFailure(evaluation)) {
    return Result.fail(error('risk', 'shadow target risk evaluation failed', evaluation.failure))
  }
  if (
    evaluation.success.policyHash !== context.policyHash ||
    evaluation.success.decision.outcome !== RiskOutcome.Blocked ||
    !evaluation.success.decision.reasonCodes.includes(Reason.AuthorityNotPaper)
  ) {
    return Result.fail(error('risk', 'OBSERVE shadow risk must remain blocked by non-paper authority'))
  }
  const target = context.targetsBySymbol.get(targetIntent.symbol)
  if (target === undefined) {
    return Result.fail(error('contract', 'planned target delta is missing its final quantity'))
  }
  const orderNotional = BigInt(evaluation.success.metrics.orderNotionalMicros)
  return Result.succeed({
    reservedBuyingPower: accumulator.reservedBuyingPower + (targetIntent.side === OrderSide.Buy ? orderNotional : 0n),
    dailyTradedNotional: accumulator.dailyTradedNotional + orderNotional,
    projectedPositions: projectTargetPosition(
      accumulator.projectedPositions,
      target,
      context.input.plannerInput.accountId,
      provided.state.positionsObservedAt,
    ),
    deltaRisk: [
      ...accumulator.deltaRisk,
      {
        notionalLimitMicros: provided.notionalLimitMicros,
        evaluation: evaluation.success,
      },
    ],
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
  const input: ObserveShadowDecisionInput = {
    ...decoded.success,
    compiledDecision: compiledDecision.success,
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
      commonExecutionSessionHash,
      plannerBrokerStateHash.success,
      plannerReconciliationHash.success,
    )
    if (Result.isFailure(stateValidation)) return Result.fail(stateValidation.failure)
  }

  const targetsBySymbol = new Map(input.targetPlan.targets.map((target) => [target.symbol, target]))
  return Result.succeed({
    input,
    policyHash: context.policyHash,
    riskInputs,
    targetsBySymbol,
    baseReservedBuyingPower,
    baseDailyTradedNotional,
    initialPositions: firstRiskInput?.state.positions ?? [],
  })
}

const reduceShadowRisk = (prepared: PreparedShadowRisk): Result.Result<ShadowReduction, ShadowDecisionError> =>
  prepared.input.targetPlan.intentTargets.reduce<Result.Result<ShadowReduction, ShadowDecisionError>>(
    (accumulator, targetIntent) =>
      Result.flatMap(accumulator, (state) =>
        reduceShadowDelta(state, targetIntent, {
          input: prepared.input,
          policyHash: prepared.policyHash,
          riskInputs: prepared.riskInputs,
          targetsBySymbol: prepared.targetsBySymbol,
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
  const planningBrokerStateHash = Result.try({
    try: () => reconciledStateHash(plannerBrokerStateMaterial(input.plannerInput)),
    catch: (cause) => error('contract', 'planning broker state hash could not be derived', cause),
  })
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
        Result.flatMap(reduceShadowRisk(prepared), (reduction) => assembleShadowDecisionDocument(context, reduction)),
      ),
    ),
  )

export const buildObserveShadowDecision = (
  input: unknown,
): Effect.Effect<ObserveShadowDecisionDocument, ShadowDecisionError> =>
  Effect.fromResult(reduceObserveShadowDecision(input))
