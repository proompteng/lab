import { Data, Result, Schema } from 'effect'

import { IntentPlanSchema, type IntentPlan } from './execution/intents'
import { desiredQuantityMicros, MICROS } from './execution-model'
import { canonicalHashV1 } from './hash'
import {
  AccountSnapshotSchema,
  AccountStatus,
  DiscrepancySchema,
  OrderSchema,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSchema,
  ReconciliationStatus,
  TimeInForce,
} from './paper'
import { reconciledStateHash } from './reconciliation'
import {
  NonNegativeIntegerSchema,
  IsoDateSchema,
  PositiveMicrosSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnitIntervalSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'

const WEIGHT_SUM_TOLERANCE = 1e-12

const SignalSessionReferencePricesSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.signal-session-reference-prices.v1'),
  signalDate: IsoDateSchema,
  observedAt: UtcInstantSchema,
  contentHash: Sha256Schema,
  priceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
})

const TargetPlannerBrokerStateSchema = Schema.Struct({
  account: AccountSnapshotSchema,
  positions: Schema.Array(PositionSchema),
  positionsObservedAt: UtcInstantSchema,
  orders: Schema.Array(OrderSchema),
  ordersObservedAt: UtcInstantSchema,
  accountingHash: Sha256Schema,
  reconciliation: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.paper-reconciliation.v1'),
    reconciliationId: Sha256Schema,
    accountId: StrictNonEmptyStringSchema,
    expectedHash: Sha256Schema,
    observedHash: Sha256Schema,
    contentHash: Sha256Schema,
    status: Schema.Enum(ReconciliationStatus),
    discrepancies: Schema.Array(DiscrepancySchema),
    reconciledAt: UtcInstantSchema,
  }),
  unknownOrderCount: NonNegativeIntegerSchema,
})

export const TargetPlannerInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-target-planner-input.v1'),
  strategyName: StrictNonEmptyStringSchema,
  cycleId: Sha256Schema,
  decisionHash: Sha256Schema,
  policyHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  signalDate: SignalSessionReferencePricesSchema.fields.signalDate,
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  referencePrices: SignalSessionReferencePricesSchema,
  brokerState: TargetPlannerBrokerStateSchema,
  precision: Schema.Struct({
    quantityIncrementMicros: PositiveMicrosSchema,
    priceIncrementMicros: PositiveMicrosSchema,
    minimumBuyNotionalMicros: PositiveMicrosSchema,
  }),
  maximumInputAgeMs: PositiveIntegerSchema,
  submissionCutoffAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
})

export type SignalSessionReferencePrices = typeof SignalSessionReferencePricesSchema.Type
export type TargetPlannerBrokerState = typeof TargetPlannerBrokerStateSchema.Type
export type TargetPlannerInput = typeof TargetPlannerInputSchema.Type

export interface PlannedTargetQuantity {
  readonly symbol: string
  readonly targetWeight: number
  readonly referencePriceMicros: string
  readonly currentQuantityMicros: string
  readonly targetQuantityMicros: string
}

export type ReferenceTargetIntent = Omit<IntentPlan, 'schemaVersion' | 'notionalLimitMicros'>

export enum TargetPlanStatus {
  Planned = 'PLANNED',
  NoTrade = 'NO_TRADE',
  Blocked = 'BLOCKED',
}

export enum TargetPlanReason {
  AccountNotActive = 'ACCOUNT_NOT_ACTIVE',
  BelowMinimumBuyNotional = 'BELOW_MINIMUM_BUY_NOTIONAL',
  IdentityMismatch = 'IDENTITY_MISMATCH',
  InputMismatch = 'INPUT_MISMATCH',
  InputStale = 'INPUT_STALE',
  InsufficientBuyingPower = 'INSUFFICIENT_BUYING_POWER',
  NonPositiveEquity = 'NON_POSITIVE_EQUITY',
  ReconciliationNotExact = 'RECONCILIATION_NOT_EXACT',
  ShortPositionNotAllowed = 'SHORT_POSITION_NOT_ALLOWED',
  SubmissionCutoffReached = 'SUBMISSION_CUTOFF_REACHED',
  TargetsSatisfied = 'TARGETS_SATISFIED',
  UnknownOrder = 'UNKNOWN_ORDER',
  UnresolvedOrder = 'UNRESOLVED_ORDER',
}

export const blockedTargetPlanReasons = [
  TargetPlanReason.AccountNotActive,
  TargetPlanReason.BelowMinimumBuyNotional,
  TargetPlanReason.IdentityMismatch,
  TargetPlanReason.InputMismatch,
  TargetPlanReason.InputStale,
  TargetPlanReason.InsufficientBuyingPower,
  TargetPlanReason.NonPositiveEquity,
  TargetPlanReason.ReconciliationNotExact,
  TargetPlanReason.ShortPositionNotAllowed,
  TargetPlanReason.SubmissionCutoffReached,
  TargetPlanReason.UnknownOrder,
  TargetPlanReason.UnresolvedOrder,
] as const
export type BlockedTargetPlanReason = (typeof blockedTargetPlanReasons)[number]

interface CanonicalizeTargetPlannerInputIssue {
  readonly operation: 'canonicalize-input'
  readonly reason: 'hash'
}

interface CanonicalizeTargetPlannerOutputIssue {
  readonly operation: 'canonicalize-output'
  readonly reason: 'hash'
}

interface DecodeTargetPlannerInputIssue {
  readonly operation: 'decode-input'
  readonly reason: 'contract'
}

interface DecodeTargetPlannerOutputIssue {
  readonly operation: 'decode-output'
  readonly reason: 'contract' | 'hash'
}

interface DeriveTargetPlannerTargetsIssue {
  readonly operation: 'derive-targets'
  readonly reason: 'precision'
}

type TargetPlannerIssue =
  | CanonicalizeTargetPlannerInputIssue
  | CanonicalizeTargetPlannerOutputIssue
  | DecodeTargetPlannerInputIssue
  | DecodeTargetPlannerOutputIssue
  | DeriveTargetPlannerTargetsIssue

interface TargetPlannerFailureDetails {
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

const TargetPlannerFailure = Data.TaggedError('TargetPlannerFailure')<TargetPlannerIssue & TargetPlannerFailureDetails>
export type TargetPlannerFailure = InstanceType<typeof TargetPlannerFailure>

const PlannedTargetQuantitySchema = Schema.Struct({
  symbol: SymbolSchema,
  targetWeight: UnitIntervalSchema,
  referencePriceMicros: PositiveMicrosSchema,
  currentQuantityMicros: UnsignedMicrosSchema,
  targetQuantityMicros: UnsignedMicrosSchema,
})

const ReferenceTargetIntentSchema = Schema.Struct({
  strategyName: IntentPlanSchema.fields.strategyName,
  cycleId: IntentPlanSchema.fields.cycleId,
  decisionHash: IntentPlanSchema.fields.decisionHash,
  policyHash: IntentPlanSchema.fields.policyHash,
  accountId: IntentPlanSchema.fields.accountId,
  symbol: IntentPlanSchema.fields.symbol,
  side: IntentPlanSchema.fields.side,
  orderType: IntentPlanSchema.fields.orderType,
  timeInForce: IntentPlanSchema.fields.timeInForce,
  quantityMicros: IntentPlanSchema.fields.quantityMicros,
  createdAt: IntentPlanSchema.fields.createdAt,
})

const TargetPlanResultFields = {
  schemaVersion: Schema.Literal('bayn.paper-reference-target-plan.v1'),
  inputHash: Sha256Schema,
  outputHash: Sha256Schema,
  targets: Schema.Array(PlannedTargetQuantitySchema),
  requiredReferenceBuyNotionalMicros: UnsignedMicrosSchema,
  availableBuyingPowerMicros: SignedMicrosSchema,
  residualBuyingPowerMicros: SignedMicrosSchema,
} as const

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

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const isStrictlySorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1] < value)

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
    if (delta > 0n) {
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
        intent.orderType !== OrderType.Market ||
        intent.timeInForce !== TimeInForce.Day)
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

// The base union decodes every micros string and plain-data field before these pure semantic phases run.
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
  const expectedHash = Result.try({
    try: () => canonicalHashV1(material),
    catch: (cause) => cause,
  })
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

type OutputMaterial = TargetPlanResult extends infer Plan
  ? Plan extends TargetPlanResult
    ? Omit<Plan, 'outputHash'>
    : never
  : never
type BlockedOutputMaterial = Extract<OutputMaterial, { readonly status: TargetPlanStatus.Blocked }>

const blocked = (
  inputHash: string,
  reason: BlockedTargetPlanReason,
  availableBuyingPowerMicros: string,
  targets: readonly PlannedTargetQuantity[] = [],
  requiredReferenceBuyNotionalMicros = '0',
): BlockedOutputMaterial => ({
  schemaVersion: 'bayn.paper-reference-target-plan.v1',
  inputHash,
  status: TargetPlanStatus.Blocked,
  reason,
  targets,
  intentTargets: [],
  requiredReferenceBuyNotionalMicros,
  availableBuyingPowerMicros,
  residualBuyingPowerMicros: availableBuyingPowerMicros,
})

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const isUnresolved = (status: OrderStatus): boolean =>
  status === OrderStatus.New || status === OrderStatus.PartiallyFilled || status === OrderStatus.Pending

const referencePriceMaterial = (referencePrices: SignalSessionReferencePrices) => ({
  schemaVersion: referencePrices.schemaVersion,
  signalDate: referencePrices.signalDate,
  observedAt: referencePrices.observedAt,
  priceMicros: referencePrices.priceMicros,
})

interface TargetPlannerHashes {
  readonly inputHash: string
  readonly referencePriceHash: string
  readonly reconciledBrokerStateHash: string
}

interface TargetPlannerFacts {
  readonly input: TargetPlannerInput
  readonly inputHash: string
  readonly referencePriceHash: string
  readonly reconciledBrokerStateHash: string
  readonly targetSymbols: readonly string[]
  readonly priceSymbols: readonly string[]
  readonly prices: ReadonlyMap<string, bigint>
  readonly positions: ReadonlyMap<string, bigint>
  readonly positionQuantities: readonly bigint[]
  readonly positionMarketValues: readonly bigint[]
  readonly observedAt: number
  readonly submissionCutoffAt: number
  readonly sourceTimes: readonly number[]
  readonly priceIncrement: bigint
  readonly quantityIncrement: bigint
  readonly minimumBuyNotional: bigint
  readonly equity: bigint
  readonly availableBuyingPower: bigint
}

interface PlannedTargetFact {
  readonly target: PlannedTargetQuantity
  readonly referencePrice: bigint
  readonly delta: bigint
}

type TargetPlannerReason<Operation extends TargetPlannerIssue['operation']> = Extract<
  TargetPlannerIssue,
  { readonly operation: Operation }
>['reason']

const canonicalizePlannerInputFailure = (
  reason: TargetPlannerReason<'canonicalize-input'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): TargetPlannerFailure => new TargetPlannerFailure({ operation: 'canonicalize-input', reason, message, facts, cause })

const canonicalizePlannerOutputFailure = (
  reason: TargetPlannerReason<'canonicalize-output'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): TargetPlannerFailure => new TargetPlannerFailure({ operation: 'canonicalize-output', reason, message, facts, cause })

const decodePlannerInputFailure = (
  reason: TargetPlannerReason<'decode-input'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): TargetPlannerFailure => new TargetPlannerFailure({ operation: 'decode-input', reason, message, facts, cause })

const decodePlannerOutputFailure = (
  reason: TargetPlannerReason<'decode-output'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): TargetPlannerFailure => new TargetPlannerFailure({ operation: 'decode-output', reason, message, facts, cause })

const deriveTargetsFailure = (
  reason: TargetPlannerReason<'derive-targets'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): TargetPlannerFailure => new TargetPlannerFailure({ operation: 'derive-targets', reason, message, facts, cause })

const decodeTargetPlannerInputResult = Schema.decodeUnknownResult(TargetPlannerInputSchema, strictParseOptions)
const decodeTargetPlanSemanticResult = Schema.decodeUnknownResult(TargetPlanResultSemanticSchema, strictParseOptions)

const deriveTargetPlannerHashes = (
  input: TargetPlannerInput,
): Result.Result<TargetPlannerHashes, TargetPlannerFailure> =>
  Result.try({
    try: () => ({
      inputHash: canonicalHashV1(input),
      referencePriceHash: canonicalHashV1(referencePriceMaterial(input.referencePrices)),
      reconciledBrokerStateHash: reconciledStateHash(input.brokerState),
    }),
    catch: (cause) =>
      canonicalizePlannerInputFailure(
        'hash',
        'validated target-planner evidence is not canonicalizable',
        { cycleId: input.cycleId },
        cause,
      ),
  })

const parseTargetPlannerFacts = (input: TargetPlannerInput, hashes: TargetPlannerHashes): TargetPlannerFacts => {
  const targetSymbols = Object.keys(input.targetWeights).sort(compareText)
  const priceSymbols = Object.keys(input.referencePrices.priceMicros).sort(compareText)
  const prices = new Map(
    Object.entries(input.referencePrices.priceMicros).map(([symbol, price]) => [symbol, BigInt(price)]),
  )
  const positionQuantities = input.brokerState.positions.map((position) => BigInt(position.quantityMicros))
  const positionMarketValues = input.brokerState.positions.map((position) => BigInt(position.marketValueMicros))
  const positions = new Map(
    input.brokerState.positions.map((position, index) => [position.symbol, positionQuantities[index]]),
  )
  return {
    input,
    ...hashes,
    targetSymbols,
    priceSymbols,
    prices,
    positions,
    positionQuantities,
    positionMarketValues,
    observedAt: Date.parse(input.observedAt),
    submissionCutoffAt: Date.parse(input.submissionCutoffAt),
    sourceTimes: [
      input.referencePrices.observedAt,
      input.brokerState.account.observedAt,
      input.brokerState.positionsObservedAt,
      input.brokerState.ordersObservedAt,
      input.brokerState.reconciliation.reconciledAt,
      ...input.brokerState.positions.map((position) => position.observedAt),
      ...input.brokerState.orders.map((order) => order.observedAt),
    ].map(Date.parse),
    priceIncrement: BigInt(input.precision.priceIncrementMicros),
    quantityIncrement: BigInt(input.precision.quantityIncrementMicros),
    minimumBuyNotional: BigInt(input.precision.minimumBuyNotionalMicros),
    equity: BigInt(input.brokerState.account.equityMicros),
    availableBuyingPower: BigInt(input.brokerState.account.buyingPowerMicros),
  }
}

const identityAndSessionMatch = (facts: TargetPlannerFacts): boolean => {
  const { input, priceSymbols, targetSymbols } = facts
  const accountId = input.accountId
  return (
    targetSymbols.length > 0 &&
    sameStrings(targetSymbols, priceSymbols) &&
    input.referencePrices.signalDate === input.signalDate &&
    input.signalDate <= input.referencePrices.observedAt.slice(0, 10) &&
    input.brokerState.account.accountId === accountId &&
    input.brokerState.reconciliation.accountId === accountId &&
    input.brokerState.positions.every(
      (position) => position.accountId === accountId && targetSymbols.includes(position.symbol),
    ) &&
    input.brokerState.orders.every((order) => order.accountId === accountId)
  )
}

const brokerStateIsCoherent = (facts: TargetPlannerFacts): boolean => {
  const { input, positionMarketValues, positionQuantities, priceIncrement, prices, quantityIncrement } = facts
  const state = input.brokerState
  const positionSymbols = state.positions.map((position) => position.symbol)
  const brokerOrderIds = state.orders.map((order) => order.brokerOrderId)
  const clientOrderIds = state.orders.map((order) => order.clientOrderId)
  const latestOrderObservation = state.orders.reduce(
    (latest, order) => (order.observedAt > latest ? order.observedAt : latest),
    '',
  )
  const unknownOrderCount = state.orders.filter((order) => order.intentId === undefined).length
  return (
    new Set(positionSymbols).size === positionSymbols.length &&
    isStrictlySorted(positionSymbols) &&
    state.positions.every((position) => position.observedAt === state.positionsObservedAt) &&
    positionQuantities.every((quantity, index) => {
      const marketValue = positionMarketValues[index]
      return (
        marketValue !== undefined &&
        (quantity === 0n) === (marketValue === 0n) &&
        (quantity <= 0n || marketValue > 0n) &&
        (quantity >= 0n || marketValue < 0n)
      )
    }) &&
    new Set(brokerOrderIds).size === brokerOrderIds.length &&
    isStrictlySorted(brokerOrderIds) &&
    new Set(clientOrderIds).size === clientOrderIds.length &&
    state.orders.every((order) => order.observedAt <= state.ordersObservedAt) &&
    (state.orders.length === 0 || latestOrderObservation === state.ordersObservedAt) &&
    state.unknownOrderCount === unknownOrderCount &&
    input.referencePrices.contentHash === facts.referencePriceHash &&
    Object.values(input.targetWeights).reduce((total, weight) => total + weight, 0) <= 1 + WEIGHT_SUM_TOLERANCE &&
    [...prices.values()].every((price) => price % priceIncrement === 0n) &&
    positionQuantities.every((quantity) => quantity % quantityIncrement === 0n)
  )
}

const brokerStateIsCurrent = (facts: TargetPlannerFacts): boolean => {
  const { input } = facts
  const state = input.brokerState
  const reconciliation = state.reconciliation
  const stateHash = facts.reconciledBrokerStateHash
  return (
    reconciliation.status === ReconciliationStatus.Exact &&
    reconciliation.discrepancies.length === 0 &&
    reconciliation.expectedHash === stateHash &&
    reconciliation.observedHash === stateHash &&
    reconciliation.reconciledAt >= state.account.observedAt &&
    reconciliation.reconciledAt >= state.positionsObservedAt &&
    reconciliation.reconciledAt >= state.ordersObservedAt
  )
}

const referenceNotional = (quantityMicros: bigint, priceMicros: bigint): bigint =>
  (quantityMicros * priceMicros + MICROS - 1n) / MICROS

const derivePlannedTargetFacts = (
  facts: TargetPlannerFacts,
): Result.Result<ReadonlyArray<PlannedTargetFact>, TargetPlannerFailure> =>
  [...facts.prices.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .reduce<Result.Result<ReadonlyArray<PlannedTargetFact>, TargetPlannerFailure>>(
      (result, [symbol, referencePrice]) =>
        Result.flatMap(result, (targetFacts) => {
          const currentQuantity = facts.positions.get(symbol) ?? 0n
          return Result.map(
            Result.try({
              try: () =>
                desiredQuantityMicros(facts.equity, facts.input.targetWeights[symbol], referencePrice, {
                  precision: facts.input.precision,
                }),
              catch: (cause) =>
                deriveTargetsFailure(
                  'precision',
                  'target quantity could not be represented at the declared precision',
                  {
                    cycleId: facts.input.cycleId,
                    symbol,
                    targetWeight: facts.input.targetWeights[symbol],
                  },
                  cause,
                ),
            }),
            (targetQuantity) => [
              ...targetFacts,
              {
                referencePrice,
                delta: targetQuantity - currentQuantity,
                target: {
                  symbol,
                  targetWeight: facts.input.targetWeights[symbol],
                  referencePriceMicros: referencePrice.toString(),
                  currentQuantityMicros: currentQuantity.toString(),
                  targetQuantityMicros: targetQuantity.toString(),
                },
              },
            ],
          )
        }),
      Result.succeed([]),
    )

const selectTargetPlannerPreflightBlock = (facts: TargetPlannerFacts): BlockedOutputMaterial | undefined => {
  const { input, inputHash } = facts
  const availableBuyingPowerMicros = input.brokerState.account.buyingPowerMicros
  if (facts.observedAt >= facts.submissionCutoffAt) {
    return blocked(inputHash, TargetPlanReason.SubmissionCutoffReached, availableBuyingPowerMicros)
  }
  if (!identityAndSessionMatch(facts)) {
    return blocked(inputHash, TargetPlanReason.IdentityMismatch, availableBuyingPowerMicros)
  }
  if (!brokerStateIsCoherent(facts)) {
    return blocked(inputHash, TargetPlanReason.InputMismatch, availableBuyingPowerMicros)
  }
  if (facts.sourceTimes.some((source) => source > facts.observedAt)) {
    return blocked(inputHash, TargetPlanReason.InputMismatch, availableBuyingPowerMicros)
  }
  if (facts.sourceTimes.some((source) => facts.observedAt - source >= input.maximumInputAgeMs)) {
    return blocked(inputHash, TargetPlanReason.InputStale, availableBuyingPowerMicros)
  }
  if (!brokerStateIsCurrent(facts)) {
    return blocked(inputHash, TargetPlanReason.ReconciliationNotExact, availableBuyingPowerMicros)
  }
  if (input.brokerState.account.status !== AccountStatus.Active) {
    return blocked(inputHash, TargetPlanReason.AccountNotActive, availableBuyingPowerMicros)
  }
  if (input.brokerState.unknownOrderCount > 0) {
    return blocked(inputHash, TargetPlanReason.UnknownOrder, availableBuyingPowerMicros)
  }
  if (input.brokerState.orders.some((order) => isUnresolved(order.status))) {
    return blocked(inputHash, TargetPlanReason.UnresolvedOrder, availableBuyingPowerMicros)
  }
  if (facts.positionQuantities.some((quantity) => quantity < 0n)) {
    return blocked(inputHash, TargetPlanReason.ShortPositionNotAllowed, availableBuyingPowerMicros)
  }
  if (facts.equity <= 0n) {
    return blocked(inputHash, TargetPlanReason.NonPositiveEquity, availableBuyingPowerMicros)
  }
  return undefined
}

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
    schemaVersion: 'bayn.paper-reference-target-plan.v1',
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

const computeTargetPlan = (facts: TargetPlannerFacts): Result.Result<OutputMaterial, TargetPlannerFailure> => {
  const preflightBlock = selectTargetPlannerPreflightBlock(facts)
  return preflightBlock === undefined
    ? Result.map(derivePlannedTargetFacts(facts), (targetFacts) => assembleExecutableTargetPlan(facts, targetFacts))
    : Result.succeed(preflightBlock)
}

const finalizeTargetPlan = (material: OutputMaterial): Result.Result<TargetPlanResult, TargetPlannerFailure> =>
  Result.flatMap(
    Result.try({
      try: () => ({ ...material, outputHash: canonicalHashV1(material) }),
      catch: (cause) =>
        canonicalizePlannerOutputFailure(
          'hash',
          'target-plan output material is not canonicalizable',
          { inputHash: material.inputHash, status: material.status },
          cause,
        ),
    }),
    decodeTargetPlanResult,
  )

export const decodeTargetPlanResult = (input: unknown): Result.Result<TargetPlanResult, TargetPlannerFailure> =>
  Result.flatMap(
    Result.mapError(decodeTargetPlanSemanticResult(input), (cause) =>
      decodePlannerOutputFailure('contract', 'target-plan output failed its durable contract', {}, cause),
    ),
    (decoded) => {
      const { outputHash, ...material } = decoded
      return Result.flatMap(
        Result.try({
          try: () => canonicalHashV1(material),
          catch: (cause) =>
            canonicalizePlannerOutputFailure(
              'hash',
              'target-plan output material is not canonicalizable',
              { inputHash: decoded.inputHash, path: ['outputHash'], status: decoded.status },
              cause,
            ),
        }),
        (expectedHash) =>
          expectedHash === outputHash
            ? Result.succeed(decoded)
            : Result.fail(
                decodePlannerOutputFailure('hash', 'target-plan output hash does not match its canonical material', {
                  expectedHash,
                  inputHash: decoded.inputHash,
                  observedHash: outputHash,
                  path: ['outputHash'],
                  status: decoded.status,
                }),
              ),
      )
    },
  )

export const planTargets = (input: unknown): Result.Result<TargetPlanResult, TargetPlannerFailure> => {
  const decoded = Result.mapError(decodeTargetPlannerInputResult(input), (cause) =>
    decodePlannerInputFailure('contract', 'target-planner input failed its durable contract', {}, cause),
  )
  return Result.flatMap(decoded, (value) =>
    Result.flatMap(deriveTargetPlannerHashes(value), (hashes) =>
      Result.flatMap(computeTargetPlan(parseTargetPlannerFacts(value, hashes)), finalizeTargetPlan),
    ),
  )
}
