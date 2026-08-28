import { Result, Schema, pipe } from 'effect'

import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { legacyReferenceTargetPlanSchemaVersion } from '../execution/legacy-wire'
import { MICROS } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import {
  canonicalizePlannerOutputFailure,
  decodePlannerOutputFailure,
  PlannedTargetQuantitySchema,
  ReferenceTargetIntentSchema,
  TargetPlanReason,
  TargetPlanResultFields,
  TargetPlanStatus,
  blockedTargetPlanReasons,
  referenceTargetPlanSchemaVersion,
  type PlannedTargetQuantity,
  type ReferenceTargetIntent,
  type TargetPlannerFailure,
} from './model'

const PlannedTargetPlanResultSchema = Schema.Struct({
  ...TargetPlanResultFields,
  status: Schema.Literal(TargetPlanStatus.Planned),
  reason: Schema.Null,
  intentTargets: Schema.Array(ReferenceTargetIntentSchema).check(Schema.isMinLength(1)),
})

const NoTradeTargetPlanResultSchema = Schema.Struct({
  ...TargetPlanResultFields,
  status: Schema.Literal(TargetPlanStatus.NoTrade),
  reason: Schema.Literal(TargetPlanReason.TargetsSatisfied),
  targets: Schema.Array(PlannedTargetQuantitySchema).check(Schema.isMinLength(1)),
  intentTargets: Schema.Tuple([]),
})

const BlockedTargetPlanResultSchema = Schema.Struct({
  ...TargetPlanResultFields,
  status: Schema.Literal(TargetPlanStatus.Blocked),
  reason: Schema.Literals(blockedTargetPlanReasons),
  intentTargets: Schema.Tuple([]),
})

const TargetPlanResultBase = Schema.Union([
  PlannedTargetPlanResultSchema,
  NoTradeTargetPlanResultSchema,
  BlockedTargetPlanResultSchema,
])

const isStrictlySorted = (values: readonly string[]): boolean =>
  values.every((value, index) => {
    if (index === 0) return true
    const previous = values[index - 1]
    return previous !== undefined && previous < value
  })

interface TargetPlanDeltaFact {
  readonly index: number
  readonly target: PlannedTargetQuantity
  readonly currentQuantity: bigint
  readonly targetQuantity: bigint
  readonly delta: bigint
  readonly intent: ReferenceTargetIntent | undefined
}

interface TargetPlanSemanticFacts {
  readonly targetSymbols: readonly string[]
  readonly intentsBySymbol: ReadonlyMap<string, ReferenceTargetIntent>
  readonly deltas: readonly TargetPlanDeltaFact[]
  readonly requiredReferenceBuyNotional: bigint
  readonly nonzeroDeltaCount: number
  readonly positiveDeltaCount: number
}

const deriveTargetPlanSemanticFacts = (result: typeof TargetPlanResultBase.Type): TargetPlanSemanticFacts => {
  const targetSymbols = result.targets.map((target) => target.symbol)
  const intentsBySymbol = new Map(result.intentTargets.map((intent) => [intent.symbol, intent]))
  let requiredReferenceBuyNotional = 0n
  let nonzeroDeltaCount = 0
  let positiveDeltaCount = 0
  const deltas = result.targets.map((target, index): TargetPlanDeltaFact => {
    const currentQuantity = BigInt(target.currentQuantityMicros)
    const targetQuantity = BigInt(target.targetQuantityMicros)
    const delta = targetQuantity - currentQuantity
    if (delta !== 0n) nonzeroDeltaCount += 1
    const exactShortCover = currentQuantity < 0n && targetQuantity === 0n && delta === -currentQuantity
    if (delta > 0n && !exactShortCover) {
      positiveDeltaCount += 1
      requiredReferenceBuyNotional += (delta * BigInt(target.referencePriceMicros) + MICROS - 1n) / MICROS
    }
    return {
      index,
      target,
      currentQuantity,
      targetQuantity,
      delta,
      intent: intentsBySymbol.get(target.symbol),
    }
  })
  return {
    targetSymbols,
    intentsBySymbol,
    deltas,
    requiredReferenceBuyNotional,
    nonzeroDeltaCount,
    positiveDeltaCount,
  }
}

const targetPlanOrderingIssues = (
  result: typeof TargetPlanResultBase.Type,
  facts: TargetPlanSemanticFacts,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (new Set(facts.targetSymbols).size !== facts.targetSymbols.length || !isStrictlySorted(facts.targetSymbols)) {
    issues.push({ path: ['targets'], issue: 'must contain one target per symbol in canonical order' })
  }
  const intentSymbols = result.intentTargets.map((intent) => intent.symbol)
  if (
    facts.intentsBySymbol.size !== result.intentTargets.length ||
    intentSymbols.some((symbol) => !facts.targetSymbols.includes(symbol))
  ) {
    issues.push({ path: ['intentTargets'], issue: 'must contain at most one delta for each persisted target' })
  }
  for (let index = 1; index < result.intentTargets.length; index += 1) {
    const previous = result.intentTargets[index - 1]
    const current = result.intentTargets[index]
    if (previous === undefined || current === undefined) continue
    if (
      (previous.side === OrderSide.Buy && current.side === OrderSide.Sell) ||
      (previous.side === current.side && previous.symbol >= current.symbol)
    ) {
      issues.push({ path: ['intentTargets'], issue: 'must be ordered sells first and then by symbol' })
      break
    }
  }
  return issues
}

const targetQuantityIssues = (facts: TargetPlanSemanticFacts): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  for (const { index, target, targetQuantity } of facts.deltas) {
    if (target.targetWeight === 0 && targetQuantity !== 0n) {
      issues.push({
        path: ['targets', index, 'targetQuantityMicros'],
        issue: 'must be zero when the target weight is zero',
      })
    }
  }
  return issues
}

const plannedIntentIssues = (
  result: typeof TargetPlanResultBase.Type,
  facts: TargetPlanSemanticFacts,
): readonly Schema.FilterIssue[] => {
  if (result.status !== TargetPlanStatus.Planned) return []
  const issues: Schema.FilterIssue[] = []
  const firstIntent = result.intentTargets[0]
  const supportedExecutionTerms = (
    intent: ReferenceTargetIntent,
    target: typeof PlannedTargetQuantitySchema.Type,
  ): boolean =>
    result.schemaVersion === legacyReferenceTargetPlanSchemaVersion
      ? intent.orderType === OrderType.Market && intent.timeInForce === TimeInForce.Day
      : result.schemaVersion === referenceTargetPlanSchemaVersion &&
        ((intent.orderType === OrderType.Limit && intent.timeInForce === TimeInForce.ImmediateOrCancel) ||
          (intent.side === OrderSide.Sell &&
            intent.orderType === OrderType.Market &&
            intent.timeInForce === TimeInForce.Day &&
            BigInt(target.currentQuantityMicros) > 0n &&
            BigInt(target.targetQuantityMicros) === 0n) ||
          (intent.side === OrderSide.Buy &&
            intent.orderType === OrderType.Market &&
            intent.timeInForce === TimeInForce.Day &&
            BigInt(target.currentQuantityMicros) < 0n &&
            BigInt(target.targetQuantityMicros) === 0n))
  for (const { delta, index, intent, target } of facts.deltas) {
    if (delta === 0n && intent !== undefined) {
      issues.push({ path: ['intentTargets'], issue: `must not retain a zero delta for ${target.symbol}` })
      continue
    }
    if (delta !== 0n && intent === undefined) {
      issues.push({ path: ['intentTargets'], issue: `must retain the nonzero delta for ${target.symbol}` })
      continue
    }
    if (
      intent !== undefined &&
      (intent.side !== (delta > 0n ? OrderSide.Buy : OrderSide.Sell) ||
        BigInt(intent.quantityMicros) !== (delta < 0n ? -delta : delta) ||
        !supportedExecutionTerms(intent, target))
    ) {
      issues.push({ path: ['intentTargets', index], issue: 'must exactly encode the target quantity delta' })
    }
    if (
      firstIntent !== undefined &&
      intent !== undefined &&
      (intent.strategyName !== firstIntent.strategyName ||
        intent.cycleId !== firstIntent.cycleId ||
        intent.decisionHash !== firstIntent.decisionHash ||
        intent.policyHash !== firstIntent.policyHash ||
        intent.accountId !== firstIntent.accountId ||
        intent.orderType !== firstIntent.orderType ||
        intent.timeInForce !== firstIntent.timeInForce ||
        intent.createdAt !== firstIntent.createdAt)
    ) {
      issues.push({ path: ['intentTargets', index], issue: 'must share one target-plan identity and creation time' })
    }
  }
  if (facts.nonzeroDeltaCount !== result.intentTargets.length) {
    issues.push({ path: ['intentTargets'], issue: 'must contain every and only nonzero target delta' })
  }
  return issues
}

const targetPlanStatusIssues = (
  result: typeof TargetPlanResultBase.Type,
  facts: TargetPlanSemanticFacts,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (result.status === TargetPlanStatus.NoTrade && facts.nonzeroDeltaCount !== 0) {
    issues.push({ path: ['status'], issue: 'NO_TRADE requires every target quantity to be satisfied' })
  }
  if (
    result.status === TargetPlanStatus.Blocked &&
    result.targets.length > 0 &&
    result.reason !== TargetPlanReason.BelowMinimumBuyNotional &&
    result.reason !== TargetPlanReason.InsufficientBuyingPower
  ) {
    issues.push({ path: ['targets'], issue: 'blocked target evidence is valid only for notional failures' })
  }
  return issues
}

const targetPlanBuyingPowerIssues = (
  result: typeof TargetPlanResultBase.Type,
  facts: TargetPlanSemanticFacts,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const required = BigInt(result.requiredReferenceBuyNotionalMicros)
  const available = BigInt(result.availableBuyingPowerMicros)
  const residual = BigInt(result.residualBuyingPowerMicros)
  if (required !== facts.requiredReferenceBuyNotional) {
    issues.push({
      path: ['requiredReferenceBuyNotionalMicros'],
      issue: 'must equal the exact aggregate reference notional of positive target deltas',
    })
  }
  const expectedResidual = result.status === TargetPlanStatus.Blocked ? available : available - required
  if (residual !== expectedResidual) {
    issues.push({ path: ['residualBuyingPowerMicros'], issue: 'must agree with target-plan buying-power arithmetic' })
  }
  if (result.status === TargetPlanStatus.Planned && required > 0n && required > available) {
    issues.push({ path: ['status'], issue: 'PLANNED requires sufficient current buying power' })
  }
  if (
    result.status === TargetPlanStatus.Blocked &&
    result.reason === TargetPlanReason.InsufficientBuyingPower &&
    (facts.positiveDeltaCount === 0 || required === 0n || required <= available)
  ) {
    issues.push({
      path: ['reason'],
      issue: 'INSUFFICIENT_BUYING_POWER requires a positive target buy and a reference shortfall',
    })
  }
  if (
    result.status === TargetPlanStatus.Blocked &&
    result.reason === TargetPlanReason.BelowMinimumBuyNotional &&
    (facts.positiveDeltaCount === 0 || required === 0n)
  ) {
    issues.push({
      path: ['requiredReferenceBuyNotionalMicros'],
      issue: 'BELOW_MINIMUM_BUY_NOTIONAL requires a positive target buy and its nonzero reference notional',
    })
  }
  return issues
}

const targetPlanSemanticIssues = (result: typeof TargetPlanResultBase.Type): readonly Schema.FilterIssue[] => {
  const facts = deriveTargetPlanSemanticFacts(result)
  return [
    ...targetPlanOrderingIssues(result, facts),
    ...targetQuantityIssues(facts),
    ...plannedIntentIssues(result, facts),
    ...targetPlanStatusIssues(result, facts),
    ...targetPlanBuyingPowerIssues(result, facts),
  ]
}

const TargetPlanResultSemanticSchema = TargetPlanResultBase.check(Schema.makeFilter(targetPlanSemanticIssues))

const targetPlanHashIssues = (result: typeof TargetPlanResultSemanticSchema.Type): readonly Schema.FilterIssue[] => {
  const { outputHash, ...material } = result
  const expectedHash = canonicalHashV1Result(material)
  if (Result.isFailure(expectedHash)) {
    return [{ path: ['outputHash'], issue: 'target-plan output material must be canonicalizable' }]
  }
  return outputHash === expectedHash.success
    ? []
    : [{ path: ['outputHash'], issue: 'must match the canonical target-plan output material' }]
}

export const TargetPlanResultSchema = TargetPlanResultSemanticSchema.check(Schema.makeFilter(targetPlanHashIssues))
export type TargetPlanResult = typeof TargetPlanResultSchema.Type
export type PlannedTargetPlanResult = Extract<TargetPlanResult, { readonly status: TargetPlanStatus.Planned }>
export type NoTradeTargetPlanResult = Extract<TargetPlanResult, { readonly status: TargetPlanStatus.NoTrade }>
export type BlockedTargetPlanResult = Extract<TargetPlanResult, { readonly status: TargetPlanStatus.Blocked }>

export type OutputMaterial = TargetPlanResult extends infer Plan
  ? Plan extends TargetPlanResult
    ? Omit<Plan, 'outputHash'>
    : never
  : never
export type BlockedOutputMaterial = Extract<OutputMaterial, { readonly status: TargetPlanStatus.Blocked }>

const decodeTargetPlanSemanticResult = Schema.decodeUnknownResult(TargetPlanResultSemanticSchema, strictParseOptions)

export const decodeTargetPlanResult = (input: unknown): Result.Result<TargetPlanResult, TargetPlannerFailure> =>
  Result.flatMap(
    Result.mapError(decodeTargetPlanSemanticResult(input), (cause) =>
      decodePlannerOutputFailure({
        reason: 'contract',
        message: 'target-plan output failed its durable contract',
        facts: {},
        cause,
      }),
    ),
    (decoded) => {
      const { outputHash, ...material } = decoded
      return Result.flatMap(
        pipe(
          canonicalHashV1Result(material),
          Result.mapError((cause) =>
            canonicalizePlannerOutputFailure({
              reason: 'hash',
              message: 'target-plan output material is not canonicalizable',
              facts: { inputHash: decoded.inputHash, path: ['outputHash'], status: decoded.status },
              cause,
            }),
          ),
        ),
        (expectedHash) =>
          expectedHash === outputHash
            ? Result.succeed(decoded)
            : Result.fail(
                decodePlannerOutputFailure({
                  reason: 'hash',
                  message: 'target-plan output hash does not match its canonical material',
                  facts: {
                    expectedHash,
                    inputHash: decoded.inputHash,
                    observedHash: outputHash,
                    path: ['outputHash'],
                    status: decoded.status,
                  },
                }),
              ),
      )
    },
  )
