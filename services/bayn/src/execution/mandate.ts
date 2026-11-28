import { Result, Schema } from 'effect'

import { notionalMicros, scaledNumber } from '../strategy/execution-model/fixed-point'
import { WEIGHT_SCALE } from '../strategy/execution-model/model'
import { Sha256Schema } from '../schemas'
import { reconciliationIncompleteRestrictionReason } from './authority'
import type { OrderStatus } from './contracts'
import { legacyAuthorityGenerationV2SchemaVersion, legacyAuthorityGenerationV3SchemaVersion } from './legacy-wire'

export const QualificationBindingSchema = Schema.Struct({
  runId: Sha256Schema,
  lockId: Sha256Schema,
  resultHash: Sha256Schema,
})

export const QualifiedCapitalGrantSchema = Schema.TaggedStruct('Qualified', {
  qualification: QualificationBindingSchema,
})
export const ResearchCapitalGrantSchema = Schema.TaggedStruct('Research', {
  planHash: Sha256Schema,
})
export const CapitalGrantSchema = Schema.Union([QualifiedCapitalGrantSchema, ResearchCapitalGrantSchema])
export type CapitalGrant = typeof CapitalGrantSchema.Type

export interface ExecutionMandateAllocationFacts {
  readonly accountEquityMicros: bigint
  readonly dailyTradedNotionalMicros: bigint
  readonly maxGrossExposureMicros: bigint
  readonly maxNetExposureMicros: bigint
  readonly maxDailyTradedNotionalMicros: bigint | null
  readonly maxAdverseSlippageBps: bigint
  readonly targetWeights: Readonly<Record<string, number>>
  readonly signedTargetWeights?: Readonly<Record<string, number>>
  readonly disjointEntry?: boolean
  readonly positions: readonly {
    readonly quantityAtoms: string
    readonly symbol: string
    readonly marketValueMicros?: string
  }[]
  readonly openOrders?: readonly {
    readonly symbol: string
    readonly side: 'BUY' | 'SELL'
    readonly status: string
    readonly quantityAtoms?: string | undefined
    readonly filledQuantityAtoms: string
    readonly limitPriceMicros?: string | undefined
    readonly stopPriceMicros?: string | undefined
    readonly intentId?: string | undefined
    readonly brokerOrderId: string
  }[]
  readonly referencePriceMicros: Readonly<Record<string, string>>
}

export type ExecutionMandateAllocationFailure =
  | ExecutionTargetAllocationFailure
  | {
      readonly _tag: 'CurrentExposureExceedsRemainingTurnover'
      readonly currentReferenceGrossExposureMicros: bigint
      readonly remainingReferenceTurnoverMicros: bigint
    }
  | { readonly _tag: 'InvalidPositionReferenceNotional'; readonly cause: unknown; readonly symbol: string }
  | { readonly _tag: 'MissingPositionReferencePrice'; readonly symbol: string }

const nonNegative = (value: bigint): bigint => (value < 0n ? 0n : value)
const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const BASIS_POINTS = 10_000n
const referenceNotionalWithinSlippage = (limit: bigint, slippageBps: bigint): bigint =>
  (nonNegative(limit) * BASIS_POINTS) / (BASIS_POINTS + nonNegative(slippageBps))

const currentReferenceGrossExposureMicros = (
  facts: ExecutionMandateAllocationFacts,
): Result.Result<bigint, ExecutionMandateAllocationFailure> =>
  facts.positions.reduce<Result.Result<bigint, ExecutionMandateAllocationFailure>>(
    (total, position) =>
      Result.flatMap(total, (current) => {
        const price = facts.referencePriceMicros[position.symbol]
        if (price === undefined) {
          if (facts.disjointEntry === true && position.marketValueMicros !== undefined) {
            return Result.succeed(current + absolute(BigInt(position.marketValueMicros)))
          }
          return Result.fail({ _tag: 'MissingPositionReferencePrice', symbol: position.symbol })
        }
        return Result.mapError(
          Result.map(
            notionalMicros(absolute(BigInt(position.quantityAtoms)), BigInt(price)),
            (notional) => current + notional,
          ),
          (cause): ExecutionMandateAllocationFailure => ({
            _tag: 'InvalidPositionReferenceNotional',
            cause,
            symbol: position.symbol,
          }),
        )
      }),
    Result.succeed(0n),
  )

const currentSignedNetExposureMicros = (facts: ExecutionMandateAllocationFacts): bigint =>
  facts.positions.reduce(
    (total, position) => total + (position.marketValueMicros === undefined ? 0n : BigInt(position.marketValueMicros)),
    0n,
  )

// Keep a type-only import of OrderStatus so mandate.ts and contracts.ts never form a runtime ESM cycle.
const TERMINAL_ORDER_STATUSES = new Set<string>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
] satisfies readonly `${OrderStatus}`[])
const isTerminalOrderStatus = (status: string): boolean => TERMINAL_ORDER_STATUSES.has(status)
const QUANTITY_SCALE = 1_000_000_000n

/**
 * Worst-case net buy/sell envelope across independently executable open orders, grouping mutually
 * exclusive protective orders by (symbol, side, intentId) to match mutation-authority.ts.
 */
const existingOpenOrderNetEnvelopeMicros = (
  facts: ExecutionMandateAllocationFacts,
): { readonly buyMicros: bigint; readonly sellMicros: bigint } => {
  const orders = facts.openOrders
  if (orders === undefined || orders.length === 0) return { buyMicros: 0n, sellMicros: 0n }
  const groupedBuys = new Map<string, bigint>()
  const groupedSells = new Map<string, bigint>()
  for (const order of orders) {
    if (isTerminalOrderStatus(order.status) || order.quantityAtoms === undefined) continue
    const remaining = BigInt(order.quantityAtoms) - BigInt(order.filledQuantityAtoms)
    if (remaining <= 0n) continue
    const limit = order.limitPriceMicros === undefined ? 0n : BigInt(order.limitPriceMicros)
    const stop = order.stopPriceMicros === undefined ? 0n : BigInt(order.stopPriceMicros)
    const price = limit >= stop ? limit : stop
    if (price <= 0n) continue
    const notional = (remaining * price + QUANTITY_SCALE - 1n) / QUANTITY_SCALE
    const groupKey =
      order.intentId !== undefined ? `${order.symbol}|${order.side}|${order.intentId}` : order.brokerOrderId
    const map = order.side === 'BUY' ? groupedBuys : groupedSells
    const prev = map.get(groupKey) ?? 0n
    if (notional > prev) map.set(groupKey, notional)
  }
  let buyMicros = 0n
  for (const value of groupedBuys.values()) buyMicros += value
  let sellMicros = 0n
  for (const value of groupedSells.values()) sellMicros += value
  return { buyMicros, sellMicros }
}

/**
 * Bounds entry target construction by a sell-plus-buy turnover upper bound. Current reference gross exposure plus
 * weighted target capital bounds every absolute target delta, including rotations; an infeasible current portfolio is
 * rejected before target planning instead of producing a risk-blocked authority transition.
 */
export const executionMandateAllocationCapitalMicros = (
  facts: ExecutionMandateAllocationFacts,
): Result.Result<bigint, ExecutionMandateAllocationFailure> => {
  const remainingReferenceTurnover =
    facts.maxDailyTradedNotionalMicros === null
      ? null
      : referenceNotionalWithinSlippage(
          nonNegative(facts.maxDailyTradedNotionalMicros - facts.dailyTradedNotionalMicros),
          facts.maxAdverseSlippageBps,
        )
  const grossTargetWeight = Result.all(
    Object.entries(facts.targetWeights).map(([symbol, weight]) =>
      Result.mapError(
        scaledNumber(weight, `target weight for ${symbol}`, Number(WEIGHT_SCALE)),
        (cause): ExecutionTargetAllocationFailure => ({ _tag: 'InvalidTargetWeight', symbol, cause }),
      ),
    ),
  ).pipe(Result.map((weights) => weights.reduce((total, weight) => total + weight, 0n)))
  return Result.flatMap(
    Result.all({ currentReferenceGrossExposure: currentReferenceGrossExposureMicros(facts), grossTargetWeight }),
    ({ currentReferenceGrossExposure, grossTargetWeight }) => {
      if (remainingReferenceTurnover !== null && currentReferenceGrossExposure > remainingReferenceTurnover) {
        return Result.fail({
          _tag: 'CurrentExposureExceedsRemainingTurnover',
          currentReferenceGrossExposureMicros: currentReferenceGrossExposure,
          remainingReferenceTurnoverMicros: remainingReferenceTurnover,
        })
      }
      if (grossTargetWeight === 0n) return Result.succeed(0n)
      const capitalForNotional = (notional: bigint): bigint =>
        (nonNegative(notional) * WEIGHT_SCALE) / grossTargetWeight
      const grossHeadroom =
        facts.disjointEntry === true
          ? nonNegative(facts.maxGrossExposureMicros - currentReferenceGrossExposure)
          : facts.maxGrossExposureMicros
      const netCapitalCap = (() => {
        if (facts.disjointEntry !== true || facts.signedTargetWeights === undefined) {
          return capitalForNotional(facts.maxNetExposureMicros)
        }
        // Bound proposed longs and shorts independently against the worst-case net envelope across
        // co-held positions and independently executable open orders, matching validateExecutionCapitalLimits.
        let longWeightUnits = 0n
        let shortWeightUnits = 0n
        for (const weight of Object.values(facts.signedTargetWeights)) {
          const scaled = BigInt(Math.round(Math.abs(weight) * Number(WEIGHT_SCALE)))
          if (weight > 0) longWeightUnits += scaled
          else if (weight < 0) shortWeightUnits += scaled
        }
        const currentNet = currentSignedNetExposureMicros(facts)
        const pendingEnvelope = existingOpenOrderNetEnvelopeMicros(facts)
        const worstPositiveNet = currentNet + pendingEnvelope.buyMicros
        const worstNegativeNet = -currentNet + pendingEnvelope.sellMicros
        const caps: bigint[] = []
        if (longWeightUnits > 0n) {
          const longHeadroom = nonNegative(facts.maxNetExposureMicros - worstPositiveNet)
          caps.push((longHeadroom * WEIGHT_SCALE) / longWeightUnits)
        }
        if (shortWeightUnits > 0n) {
          const shortHeadroom = nonNegative(facts.maxNetExposureMicros - worstNegativeNet)
          caps.push((shortHeadroom * WEIGHT_SCALE) / shortWeightUnits)
        }
        if (caps.length === 0) {
          return absolute(currentNet) <= facts.maxNetExposureMicros ? facts.accountEquityMicros : 0n
        }
        return caps.reduce((minimum, value) => (value < minimum ? value : minimum))
      })()
      return Result.succeed(
        [
          facts.accountEquityMicros,
          capitalForNotional(grossHeadroom),
          netCapitalCap,
          ...(remainingReferenceTurnover === null
            ? []
            : [capitalForNotional(remainingReferenceTurnover - currentReferenceGrossExposure)]),
        ]
          .map(nonNegative)
          .reduce((minimum, value) => (value < minimum ? value : minimum)),
      )
    },
  )
}

export interface ExecutionTargetAllocationFacts {
  readonly allocationCapitalMicros: bigint
  readonly maxOrderNotionalMicros: bigint
  readonly maxSymbolExposureMicros: bigint
  readonly maxAdverseSlippageBps: bigint
  readonly targetWeights: Readonly<Record<string, number>>
}

export type ExecutionTargetAllocationFailure = {
  readonly _tag: 'InvalidTargetWeight'
  readonly symbol: string
  readonly cause: unknown
}

/** Buy limits round down; only the order cap needs slippage because exposure gates use reference prices. */
export const constrainExecutionTargetAllocationCapitalMicros = (
  facts: ExecutionTargetAllocationFacts,
): Result.Result<bigint, ExecutionTargetAllocationFailure> => {
  const referenceOrderLimit = referenceNotionalWithinSlippage(facts.maxOrderNotionalMicros, facts.maxAdverseSlippageBps)
  const targetNotionalLimit =
    referenceOrderLimit < facts.maxSymbolExposureMicros ? referenceOrderLimit : facts.maxSymbolExposureMicros
  return Object.entries(facts.targetWeights).reduce<Result.Result<bigint, ExecutionTargetAllocationFailure>>(
    (bounded, [symbol, weight]) =>
      Result.flatMap(bounded, (current) =>
        Result.mapError(scaledNumber(weight, `target weight for ${symbol}`, Number(WEIGHT_SCALE)), (cause) => ({
          _tag: 'InvalidTargetWeight' as const,
          symbol,
          cause,
        })).pipe(
          Result.map((weightUnits) => {
            if (weightUnits === 0n) return current
            const targetBound = (targetNotionalLimit * WEIGHT_SCALE) / weightUnits
            return targetBound < current ? targetBound : current
          }),
        ),
      ),
    Result.succeed(nonNegative(facts.allocationCapitalMicros)),
  )
}

export const capitalGrantKey = (grant: CapitalGrant): string =>
  grant._tag === 'Qualified' ? grant.qualification.runId : grant.planHash

export type LegacyCapitalGrantGenerationBinding =
  | {
      readonly schemaVersion: typeof legacyAuthorityGenerationV2SchemaVersion
      readonly qualificationRunId: string
      readonly qualificationLockId: string
      readonly qualificationResultHash: string
    }
  | {
      readonly schemaVersion: typeof legacyAuthorityGenerationV3SchemaVersion
      readonly grant: Extract<CapitalGrant, { readonly _tag: 'Research' }>
    }

/** Projects legacy qualification-bound history into the mandate grant without rewriting durable rows. */
export const capitalGrantFromLegacyGeneration = (generation: LegacyCapitalGrantGenerationBinding): CapitalGrant =>
  generation.schemaVersion === legacyAuthorityGenerationV3SchemaVersion
    ? generation.grant
    : {
        _tag: 'Qualified',
        qualification: {
          runId: generation.qualificationRunId,
          lockId: generation.qualificationLockId,
          resultHash: generation.qualificationResultHash,
        },
      }

export type ExecutionMandateFailure = { readonly _tag: 'IdentityDrift' }

export interface ExecutionMandateAuthorityFacts {
  readonly generationHash: string
  readonly sourceGenerationHash: string
  readonly currentGenerationMatchesRequest: boolean
  readonly maximum: 'OBSERVE' | 'PAPER'
  readonly effective: 'OBSERVE' | 'PAPER'
  readonly kill: 'CLEAR' | 'ACTIVE'
  readonly reason?: string
}

export const strategyProtocolCutoverRestrictionReason = 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER'

export const executionCycleRestrictionSubject = 'execution cycle loop'
export const executionActivationRestrictionSubject = 'execution activation lease'
/** Persistence-only subject retained for the durable completion reason consumed by migrated database predicates. */
export const executionMandateCompletionPersistenceSubject = 'execution episode'
export const executionMandateFailureRestrictionPrefix = `${executionCycleRestrictionSubject} restricted effective authority:`
export const legacyExecutionMandateFailureRestrictionPrefix =
  'PAPER autonomous cycle loop restricted effective authority:'
export const legacyExecutionMandateFailureRestrictionPattern =
  '^bound PAPER cycle [0-9a-f]{64} restricted effective authority: intent [0-9a-f]{64} (submit settled (denied|rejected)|ended (BLOCKED|CANCELED|EXPIRED|REJECTED|without outcome))$'
const legacyExecutionMandateFailureRestriction = new RegExp(legacyExecutionMandateFailureRestrictionPattern)
export const reconciliationDiscrepancyRestrictionPattern = '^reconciliation discrepancy [0-9a-f]{64}$'
const reconciliationDiscrepancyRestriction = new RegExp(reconciliationDiscrepancyRestrictionPattern)

/** Accepts only system-authored failure restrictions; operator kills and malformed legacy reasons stay fail-closed. */
export const isExecutionMandateFailureRestriction = (reason: string | undefined): boolean =>
  reason?.startsWith(executionMandateFailureRestrictionPrefix) === true ||
  reason?.startsWith(legacyExecutionMandateFailureRestrictionPrefix) === true ||
  (reason !== undefined &&
    (legacyExecutionMandateFailureRestriction.test(reason) || reconciliationDiscrepancyRestriction.test(reason)))

const unfinishedCycleReadFailure = 'oldest unfinished mutation cycle read failed'

/** A database read failed before a cycle, intent, or broker mutation could advance. */
export const isExecutionCyclePreflightStoreRestriction = (reason: string | undefined): boolean =>
  reason === `${executionMandateFailureRestrictionPrefix} read-oldest-unfinished: ${unfinishedCycleReadFailure}` ||
  reason === `${executionMandateFailureRestrictionPrefix} recover-cycle: ${unfinishedCycleReadFailure}`

/** Restrictions whose current bound cycle must be allowed to reach the existing terminal recovery owner. */
export const isExecutionMandateRecoveryRestriction = (reason: string | undefined): boolean =>
  reason === strategyProtocolCutoverRestrictionReason ||
  reason === 'BLOCKED_AVAILABLE_HISTORY_CUTOVER' ||
  reason === 'BLOCKED_CONTINUOUS_CASH_SPOT_CUTOVER' ||
  reason === reconciliationIncompleteRestrictionReason ||
  isExecutionMandateFailureRestriction(reason)

/** Durable persisted reason retained byte-for-byte so existing database rearm predicates keep accepting new mandates. */
export const executionMandateCompletedRestrictionReason = `${executionMandateCompletionPersistenceSubject} restricted effective authority: flat exact receipt finalized`
export const legacyV1CompletedRestrictionReason =
  'PAPER episode restricted effective authority: flat exact receipt finalized'
export const executionActivationExpiredRestrictionReason = `${executionActivationRestrictionSubject} restricted effective authority: immutable activation request expired`
export const legacyExecutionActivationExpiredRestrictionReason =
  'PAPER activation lease restricted effective authority: immutable activation request expired'

export const isRetiredOneShotMandateRestriction = (reason: string | undefined): boolean =>
  reason === executionMandateCompletedRestrictionReason ||
  reason === legacyV1CompletedRestrictionReason ||
  reason === executionActivationExpiredRestrictionReason ||
  reason === legacyExecutionActivationExpiredRestrictionReason

export type ExecutionMandateAuthorityDecision =
  | { readonly _tag: 'Activate' }
  | { readonly _tag: 'Rearm' }
  | { readonly _tag: 'Resume' }
  | { readonly _tag: 'ResumeRestricted' }

export const decideExecutionMandateAuthority = (
  facts: ExecutionMandateAuthorityFacts,
): Result.Result<ExecutionMandateAuthorityDecision, ExecutionMandateFailure> => {
  if (
    facts.maximum === 'OBSERVE' &&
    facts.effective === 'OBSERVE' &&
    facts.kill === 'CLEAR' &&
    facts.generationHash === facts.sourceGenerationHash
  ) {
    return Result.succeed({ _tag: 'Activate' })
  }
  if (
    facts.maximum === 'OBSERVE' &&
    facts.effective === 'OBSERVE' &&
    facts.kill === 'ACTIVE' &&
    facts.reason === reconciliationIncompleteRestrictionReason &&
    facts.generationHash === facts.sourceGenerationHash
  ) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  if (
    facts.maximum === 'PAPER' &&
    facts.effective === 'PAPER' &&
    facts.kill === 'CLEAR' &&
    facts.currentGenerationMatchesRequest
  ) {
    return Result.succeed({ _tag: 'Resume' })
  }
  if (
    facts.maximum === 'PAPER' &&
    facts.effective === 'PAPER' &&
    facts.kill === 'CLEAR' &&
    !facts.currentGenerationMatchesRequest &&
    facts.generationHash !== facts.sourceGenerationHash
  ) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  const isRestrictedPaperAuthority =
    facts.maximum === 'PAPER' &&
    facts.effective === 'OBSERVE' &&
    facts.kill === 'ACTIVE' &&
    facts.generationHash !== facts.sourceGenerationHash
  if (
    isRestrictedPaperAuthority &&
    facts.reason === strategyProtocolCutoverRestrictionReason &&
    !facts.currentGenerationMatchesRequest
  ) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  if (isRestrictedPaperAuthority && facts.reason === reconciliationIncompleteRestrictionReason) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  if (isRestrictedPaperAuthority && isExecutionCyclePreflightStoreRestriction(facts.reason)) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  if (isRestrictedPaperAuthority && isRetiredOneShotMandateRestriction(facts.reason)) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  if (isRestrictedPaperAuthority && isExecutionMandateFailureRestriction(facts.reason)) {
    return Result.succeed({ _tag: facts.currentGenerationMatchesRequest ? 'ResumeRestricted' : 'Rearm' })
  }
  return Result.fail({ _tag: 'IdentityDrift' })
}

export type ExecutionMandateCycleTerminalizationDecision =
  | { readonly _tag: 'WaitForClose' }
  | { readonly _tag: 'Block' }
  | { readonly _tag: 'Complete' }

export const decideExecutionMandateCycleTerminalization = (input: {
  readonly closeOnly: boolean
  readonly observedAt: string
  readonly entryCutoffAt?: string
  readonly entryHasUnsuccessfulIntent: boolean
  readonly entrySettledWithoutFill: boolean
}): ExecutionMandateCycleTerminalizationDecision => {
  if (!input.closeOnly && input.entryCutoffAt !== undefined && input.observedAt < input.entryCutoffAt) {
    return input.entrySettledWithoutFill ? { _tag: 'Complete' } : { _tag: 'WaitForClose' }
  }
  if (input.entryHasUnsuccessfulIntent) {
    return { _tag: 'Block' }
  }
  return { _tag: 'Complete' }
}
