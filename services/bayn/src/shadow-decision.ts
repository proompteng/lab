import { Data, Effect } from 'effect'

import type { AutonomousCycle } from './cycle'
import { CycleState } from './cycle'
import { plan, type IntentPlan } from './execution/intents'
import { canonicalHashV1 } from './hash'
import { Authority, OrderSide, RiskOutcome, type Position } from './paper'
import { reconciledStateHash } from './reconciliation'
import { decodeState, evaluate, Reason, type Policy, type State } from './risk'
import {
  makeObserveShadowDecisionDocument,
  type DeltaRiskEvaluation,
  type ObserveShadowDecisionDocument,
} from './shadow-decision-contract'
import { TargetPlanStatus, planTargets, type PlannedTargetQuantity, type TargetPlannerInput } from './target-planner'
import type { DecisionPlan } from './types'

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

const fail = (failure: ShadowDecisionError['failure'], message: string): Effect.Effect<never, ShadowDecisionError> =>
  Effect.fail(error(failure, message))

const sameHash = (left: unknown, right: unknown): boolean => canonicalHashV1(left) === canonicalHashV1(right)

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

const QUANTITY_SCALE = 1_000_000n
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

const validateBindings = (
  input: ObserveShadowDecisionInput,
  strategyDecisionHash: string,
  policyHash: string,
): string | null => {
  const { cycle, plannerInput, snapshot } = input
  if (cycle.state !== CycleState.Active) return 'shadow planning requires an active autonomous cycle'
  if (cycle.bindings.snapshotId !== snapshot.snapshotId) {
    return 'shadow snapshot must match the immutable cycle snapshot binding'
  }
  if (
    plannerInput.cycleId !== cycle.identity.cycleId ||
    plannerInput.strategyName !== cycle.identity.strategyName ||
    plannerInput.accountId !== cycle.identity.accountId ||
    plannerInput.signalDate !== cycle.identity.signalSessionDate ||
    plannerInput.submissionCutoffAt !== cycle.window.submissionCutoffAt
  ) {
    return 'target planner identity must match the active autonomous cycle'
  }
  if (
    plannerInput.decisionHash !== strategyDecisionHash ||
    plannerInput.policyHash !== policyHash ||
    input.policy.accountId !== cycle.identity.accountId
  ) {
    return 'target planner decision and policy must match the compiled shadow inputs'
  }
  if (
    input.compiledDecision.signalDate !== plannerInput.signalDate ||
    !sameHash(input.compiledDecision.targetWeights, plannerInput.targetWeights)
  ) {
    return 'compiled strategy decision must match the target planner weights and signal session'
  }
  if (plannerInput.observedAt < cycle.updatedAt) {
    return 'shadow decision creation cannot precede the durable cycle state'
  }
  return null
}

const validateRiskState = (
  input: ObserveShadowDecisionInput,
  riskInput: ShadowDeltaRiskInput,
  commonExecutionSessionHash: string,
): string | null => {
  const { cycle, plannerInput, snapshot } = input
  const state = riskInput.state
  if (state.authority.effective !== Authority.Observe) return 'shadow risk requires effective OBSERVE authority'
  if (state.evaluatedAt !== plannerInput.observedAt) return 'shadow risk time must match target planning time'
  if (state.marketDataSymbol !== riskInput.symbol) return 'shadow risk market symbol must match its target delta'
  if (state.marketDataHash !== snapshot.contentHash) return 'shadow risk data must match the finalized snapshot content'
  if (
    state.executionSession.signal.sessionDate !== cycle.identity.signalSessionDate ||
    state.executionSession.signal.finalizedAt !== snapshot.finalizedAt ||
    state.executionSession.signal.contentHash !== snapshot.contentHash
  ) {
    return 'shadow risk signal binding must match the finalized cycle snapshot'
  }
  if (
    state.executionSession.executionSession.date !== cycle.identity.executionSessionDate ||
    state.executionSession.executionSession.openAt !== cycle.window.executionOpenAt ||
    state.executionSession.executionSession.closeAt !== cycle.window.executionCloseAt ||
    state.executionSession.submissionCutoffAt !== cycle.window.submissionCutoffAt ||
    state.executionSession.submissionOpenAt < cycle.window.submissionOpenAt
  ) {
    return 'shadow risk execution session must remain inside the immutable cycle window'
  }
  if (state.executionSession.bindingHash !== commonExecutionSessionHash) {
    return 'every target delta must use one execution-session binding'
  }
  if (
    state.referencePriceMicros !== plannerInput.referencePrices.priceMicros[riskInput.symbol] ||
    !sameHash(riskBrokerStateMaterial(state), plannerBrokerStateMaterial(plannerInput)) ||
    !sameHash(state.reconciliation, plannerInput.brokerState.reconciliation)
  ) {
    return 'shadow risk must use the exact target-planning price, account, and reconciliation state'
  }
  return null
}

export const buildObserveShadowDecision = (
  input: ObserveShadowDecisionInput,
): Effect.Effect<ObserveShadowDecisionDocument, ShadowDecisionError> =>
  Effect.gen(function* () {
    const strategyDecisionHash = canonicalHashV1(input.compiledDecision)
    const policyHash = canonicalHashV1(input.policy)
    const bindingFailure = validateBindings(input, strategyDecisionHash, policyHash)
    if (bindingFailure !== null) return yield* fail('binding', bindingFailure)

    const planner = yield* Effect.try({
      try: () => planTargets(input.plannerInput),
      catch: (cause) => error('contract', 'target planning failed', cause),
    })
    if (planner.status !== TargetPlanStatus.Planned && input.riskInputs.length !== 0) {
      return yield* fail('binding', 'NO_TRADE and BLOCKED target plans cannot retain ignored risk inputs')
    }
    if (planner.status === TargetPlanStatus.Planned && planner.intentTargets.length !== input.riskInputs.length) {
      return yield* fail('binding', 'planned target deltas require exactly one risk input per symbol')
    }

    const riskInputs = new Map(input.riskInputs.map((riskInput) => [riskInput.symbol, riskInput]))
    if (riskInputs.size !== input.riskInputs.length) {
      return yield* fail('binding', 'shadow risk inputs must contain unique symbols')
    }
    const firstRiskInput = input.riskInputs[0]
    const commonExecutionSessionHash = firstRiskInput?.state.executionSession.bindingHash ?? ''
    const baseReservedBuyingPower = firstRiskInput?.state.reservedBuyingPowerMicros ?? '0'
    const baseDailyTradedNotional = firstRiskInput?.state.dailyTradedNotionalMicros ?? '0'
    for (const candidate of input.riskInputs) {
      if (
        candidate.state.reservedBuyingPowerMicros !== baseReservedBuyingPower ||
        candidate.state.dailyTradedNotionalMicros !== baseDailyTradedNotional
      ) {
        return yield* fail(
          'binding',
          'every shadow risk input must start from one reservation and daily-notional state',
        )
      }
      const stateFailure = validateRiskState(input, candidate, commonExecutionSessionHash)
      if (stateFailure !== null) return yield* fail('binding', stateFailure)
    }

    let reservedBuyingPower = BigInt(baseReservedBuyingPower)
    let dailyTradedNotional = BigInt(baseDailyTradedNotional)
    let projectedPositions = firstRiskInput?.state.positions ?? []
    const targetsBySymbol = new Map(planner.targets.map((target) => [target.symbol, target]))
    const deltaRisk: DeltaRiskEvaluation[] = []

    for (const targetIntent of planner.intentTargets) {
      const provided = riskInputs.get(targetIntent.symbol)
      if (provided === undefined) return yield* fail('binding', 'planned target delta is missing its risk input')
      const intentPlan: IntentPlan = {
        schemaVersion: 'bayn.paper-intent-plan.v1',
        ...targetIntent,
        notionalLimitMicros: provided.notionalLimitMicros,
      }
      const intent = yield* plan(intentPlan).pipe(
        Effect.mapError((cause) => error('contract', 'shadow target delta could not form a valid risk intent', cause)),
      )
      const state = yield* decodeState({
        ...provided.state,
        reservedBuyingPowerMicros: reservedBuyingPower.toString(),
        dailyTradedNotionalMicros: dailyTradedNotional.toString(),
      }).pipe(Effect.mapError((cause) => error('contract', 'cumulative shadow risk state is invalid', cause)))
      const evaluation = yield* Effect.try({
        try: () => evaluate(intent, state, input.policy, projectedPositions),
        catch: (cause) => error('risk', 'shadow target risk evaluation failed', cause),
      })
      if (
        evaluation.policyHash !== policyHash ||
        evaluation.decision.outcome !== RiskOutcome.Blocked ||
        !evaluation.decision.reasonCodes.includes(Reason.AuthorityNotPaper)
      ) {
        return yield* fail('risk', 'OBSERVE shadow risk must remain blocked by non-paper authority')
      }

      const orderNotional = BigInt(evaluation.metrics.orderNotionalMicros)
      dailyTradedNotional += orderNotional
      if (targetIntent.side === OrderSide.Buy) reservedBuyingPower += orderNotional
      const target = targetsBySymbol.get(targetIntent.symbol)
      if (target === undefined) return yield* fail('contract', 'planned target delta is missing its final quantity')
      projectedPositions = projectTargetPosition(
        projectedPositions,
        target,
        input.plannerInput.accountId,
        provided.state.positionsObservedAt,
      )
      deltaRisk.push({
        notionalLimitMicros: provided.notionalLimitMicros,
        evaluation,
      })
    }

    const document = yield* Effect.try({
      try: () =>
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
            planningBrokerStateHash: reconciledStateHash(plannerBrokerStateMaterial(input.plannerInput)),
            reconciliationId: input.plannerInput.brokerState.reconciliation.reconciliationId,
            reconciliationHash: input.plannerInput.brokerState.reconciliation.contentHash,
          },
          targetPlan: planner,
          deltaRisk,
          submissionCutoffAt: input.cycle.window.submissionCutoffAt,
          expiresAt: input.cycle.window.submissionCutoffAt,
          createdAt: input.plannerInput.observedAt,
        }),
      catch: (cause) => error('contract', 'shadow decision document failed durable contract validation', cause),
    })
    if (input.cycle.bindings.decisionHash !== undefined && input.cycle.bindings.decisionHash !== document.contentHash) {
      return yield* fail('binding', 'shadow document must match the immutable cycle decision binding')
    }
    return document
  })
