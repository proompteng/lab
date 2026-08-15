import { Result, pipe } from 'effect'

import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { legacyReferenceTargetPlanSchemaVersion } from '../execution/legacy-wire'
import { canonicalHashV1Result } from '../hash'
import {
  TargetPlanReason,
  TargetPlanStatus,
  canonicalizePlannerOutputFailure,
  type BlockedTargetPlanReason,
  type PlannedTargetQuantity,
  type ReferenceTargetIntent,
  type TargetPlannerFailure,
  type TargetPlannerInput,
} from './model'
import {
  compareText,
  derivePlannedTargetFacts,
  referenceNotional,
  selectTargetPlannerPreflightReason,
  type PlannedTargetFact,
  type TargetPlannerFacts,
} from './facts'
import {
  decodeTargetPlanResult,
  type BlockedOutputMaterial,
  type OutputMaterial,
  type TargetPlanResult,
} from './result'

const blocked = (
  inputHash: string,
  reason: BlockedTargetPlanReason,
  availableBuyingPowerMicros: string,
  targets: readonly PlannedTargetQuantity[] = [],
  requiredReferenceBuyNotionalMicros = '0',
): BlockedOutputMaterial => ({
  schemaVersion: legacyReferenceTargetPlanSchemaVersion,
  inputHash,
  status: TargetPlanStatus.Blocked,
  reason,
  targets,
  intentTargets: [],
  requiredReferenceBuyNotionalMicros,
  availableBuyingPowerMicros,
  residualBuyingPowerMicros: availableBuyingPowerMicros,
})

const makeReferenceTargetIntents = (
  input: TargetPlannerInput,
  targetFacts: readonly PlannedTargetFact[],
): readonly ReferenceTargetIntent[] =>
  targetFacts
    .flatMap(({ target, delta }): readonly ReferenceTargetIntent[] =>
      delta === 0n
        ? []
        : [
            {
              strategyName: input.strategyName,
              cycleId: input.cycleId,
              decisionHash: input.decisionHash,
              policyHash: input.policyHash,
              accountId: input.accountId,
              symbol: target.symbol,
              side: delta > 0n ? OrderSide.Buy : OrderSide.Sell,
              orderType: OrderType.Market,
              timeInForce: TimeInForce.Day,
              quantityMicros: (delta < 0n ? -delta : delta).toString(),
              createdAt: input.observedAt,
            },
          ],
    )
    .sort((left, right) => {
      if (left.side !== right.side) return left.side === OrderSide.Sell ? -1 : 1
      return compareText(left.symbol, right.symbol)
    })

const selectTargetNotionalBlock = (
  facts: TargetPlannerFacts,
  targets: readonly PlannedTargetQuantity[],
  requiredReferenceBuyNotionals: readonly bigint[],
): BlockedOutputMaterial | undefined => {
  const requiredBuyingPower = requiredReferenceBuyNotionals.reduce((total, value) => total + value, 0n)
  const availableBuyingPowerMicros = facts.input.brokerState.account.buyingPowerMicros
  if (requiredReferenceBuyNotionals.some((notional) => notional < facts.minimumBuyNotional)) {
    return blocked(
      facts.inputHash,
      TargetPlanReason.BelowMinimumBuyNotional,
      availableBuyingPowerMicros,
      targets,
      requiredBuyingPower.toString(),
    )
  }
  return requiredBuyingPower > 0n && requiredBuyingPower > facts.availableBuyingPower
    ? blocked(
        facts.inputHash,
        TargetPlanReason.InsufficientBuyingPower,
        availableBuyingPowerMicros,
        targets,
        requiredBuyingPower.toString(),
      )
    : undefined
}

const assembleExecutableTargetPlan = (
  facts: TargetPlannerFacts,
  targetFacts: readonly PlannedTargetFact[],
): OutputMaterial => {
  const targets = targetFacts.map((fact) => fact.target)
  const intents = makeReferenceTargetIntents(facts.input, targetFacts)
  const requiredReferenceBuyNotionals = targetFacts
    .filter((fact) => fact.delta > 0n)
    .map((fact) => referenceNotional(fact.delta, fact.referencePrice))
  const requiredBuyingPower = requiredReferenceBuyNotionals.reduce((total, value) => total + value, 0n)
  const notionalBlock = selectTargetNotionalBlock(facts, targets, requiredReferenceBuyNotionals)
  if (notionalBlock !== undefined) return notionalBlock
  const common = {
    schemaVersion: legacyReferenceTargetPlanSchemaVersion,
    inputHash: facts.inputHash,
    targets,
    requiredReferenceBuyNotionalMicros: requiredBuyingPower.toString(),
    availableBuyingPowerMicros: facts.input.brokerState.account.buyingPowerMicros,
    residualBuyingPowerMicros: (facts.availableBuyingPower - requiredBuyingPower).toString(),
  } as const
  return intents.length === 0
    ? {
        ...common,
        status: TargetPlanStatus.NoTrade,
        reason: TargetPlanReason.TargetsSatisfied,
        intentTargets: [],
      }
    : {
        ...common,
        status: TargetPlanStatus.Planned,
        reason: null,
        intentTargets: intents,
      }
}

export const computeTargetPlan = (facts: TargetPlannerFacts): Result.Result<OutputMaterial, TargetPlannerFailure> => {
  const preflightReason = selectTargetPlannerPreflightReason(facts)
  return preflightReason === undefined
    ? Result.map(derivePlannedTargetFacts(facts), (targetFacts) => assembleExecutableTargetPlan(facts, targetFacts))
    : Result.succeed(blocked(facts.inputHash, preflightReason, facts.input.brokerState.account.buyingPowerMicros))
}

export const finalizeTargetPlan = (material: OutputMaterial): Result.Result<TargetPlanResult, TargetPlannerFailure> =>
  Result.flatMap(
    pipe(
      canonicalHashV1Result(material),
      Result.mapError((cause) =>
        canonicalizePlannerOutputFailure({
          reason: 'hash',
          message: 'target-plan output material is not canonicalizable',
          facts: { inputHash: material.inputHash, status: material.status },
          cause,
        }),
      ),
    ),
    (outputHash) => decodeTargetPlanResult({ ...material, outputHash }),
  )
