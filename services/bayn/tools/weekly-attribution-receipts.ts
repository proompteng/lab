import { Data, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import { compareIntradayInstants as compareAt } from '../src/market-data/intraday/time'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema as Count,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
} from '../src/schemas'
import { macroCanaryEtfs, MacroCanaryEtfSchema } from '../src/strategy/macro-canary-etf/policy'
import { universe } from '../src/strategy/macro-etf-core/policy'
import { AccountId, Bar } from './macro-canary-runner/alpaca'
import { orderPrefix as canaryOrderPrefix } from './macro-canary-runner/planner'
import { intradaySymbols, RunnerProfile } from './macro-etf-core-runner/contract'
import { orderPrefix as coreOrderPrefix } from './macro-etf-core-runner/planner'
import { CanaryProfile, SleeveMode, Strategy } from './multi-account-daily-sleeves/contract'
import { Gate } from './multi-horizon-scorecard-core'
import { AuditReceipt, CoreReceipt, Micros, UnsignedMicros } from './multi-horizon-scorecard-receipts'

export enum Disposition {
  Shadow = 'shadow',
  Submitted = 'submitted',
  NoOrders = 'no-orders',
  Withheld = 'withheld',
  Failed = 'failed',
}

export enum RotationPhase {
  Hold = 'hold',
  Reduce = 'reduce',
  Increase = 'increase',
}

export enum HoldReason {
  OutsideReview = 'OutsideReview',
  NoWholeShareDrift = 'NoWholeShareDrift',
  NoCapacity = 'NoCapacity',
}

enum MacroRegime {
  Goldilocks = 'Goldilocks',
  Reflation = 'Reflation',
  Stagflation = 'Stagflation',
  DeflationaryCrash = 'DeflationaryCrash',
}

export class WeeklyAttributionError extends Data.TaggedError('WeeklyAttributionError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

export const attributionError = (message: string, cause: unknown) =>
  new WeeklyAttributionError({ message, cause: Redacted.make(cause) })

export const receiptHash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(
    Result.mapError((cause) => attributionError('Cannot hash attribution evidence', cause)),
  )

const Bool = Schema.Boolean
const Text = StrictNonEmptyStringSchema
const Symbols = Schema.Array(SymbolSchema)
const SleeveId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))
const Mode = Schema.Enum(SleeveMode)
const Date = IsoDateSchema
const sessions = { signalSession: Date, executionSession: Date }
const corePlanVersion = 'bayn.macro-etf-core-next-open-sleeve-receipt.v1'
const canaryPlanVersion = 'bayn.macro-canary-next-open-sleeve-receipt.v1'

// The portfolio runner hashes the core material without the standalone reconciliation envelope.
const CorePlanReceipt = CoreReceipt.mapFields(({ reconciliation: _reconciliation, ...fields }) => ({
  ...fields,
  schemaVersion: Schema.Literal(corePlanVersion),
  mode: Mode,
  snapshotSha256: Sha256Schema,
}))
export type CorePlanReceipt = typeof CorePlanReceipt.Type

const EtfWeights = Schema.Record(MacroCanaryEtfSchema, Schema.Finite)
const PartialEtfVector = Schema.Record(MacroCanaryEtfSchema, Schema.optionalKey(Schema.Finite))
const ArmWeights = Schema.Struct({ canary: Schema.Finite, trend: Schema.Finite, macro: Schema.Finite })
const OrderRequest = CoreReceipt.fields.plan.fields.orders.value.fields.request

const CanaryPlanReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(canaryPlanVersion),
  ...sessions,
  mode: Mode,
  broker: Schema.Literal('alpaca-paper'),
  marketSha256: Sha256Schema,
  sleeveSha256: Sha256Schema,
  snapshotSha256: Sha256Schema,
  observedAt: UtcInstantSchema,
  target: Schema.Struct({
    signalSession: Date,
    nextOpenSession: Date,
    review: Bool,
    policyHash: Sha256Schema,
    targetWeights: EtfWeights,
    attribution: Schema.Struct({
      canary: Schema.Struct({
        reviewedAt: Date,
        offCount: Count,
        defensiveBudget: Schema.Finite,
        scores: PartialEtfVector,
        weights: EtfWeights,
      }),
      trend: Schema.Struct({ zScores: PartialEtfVector, weights: EtfWeights }),
      macro: Schema.Struct({
        regime: Schema.Enum(MacroRegime),
        credit: Schema.Finite,
        inflation: Schema.Finite,
        dollar: Schema.Finite,
        strongDollar: Bool,
        unsmoothedWeights: EtfWeights,
        weights: EtfWeights,
      }),
      blendWeights: ArmWeights,
      ensembleWeights: EtfWeights,
      idleShyWeight: Schema.Finite,
      unsweptCashWeight: Schema.Finite,
    }),
  }),
  resumedRotation: Schema.NullOr(Schema.Struct({ signalSession: Date, planSha256: Sha256Schema })),
  effectiveTargetWeights: EtfWeights,
  rawSizingBars: Schema.Array(Schema.Struct({ symbol: MacroCanaryEtfSchema, bar: Bar })),
  budgetCents: Count,
  spendableCents: Count,
  remainingOneWayTurnoverBps: Schema.NullOr(Count),
  phase: Schema.Enum(RotationPhase),
  holdReason: Schema.NullOr(Schema.Enum(HoldReason)),
  orders: Schema.Array(Schema.Struct({ request: OrderRequest })),
  planSha256: Sha256Schema,
})
export type CanaryPlanReceipt = typeof CanaryPlanReceipt.Type

const binding = { sleeveId: SleeveId, accountId: AccountId }
const Binding = Schema.Struct({
  ...binding,
  strategy: Schema.Enum(Strategy),
  profile: Schema.Union([Schema.Enum(RunnerProfile), Schema.Enum(CanaryProfile)]),
  activeSymbols: Symbols,
  excludeSymbols: Symbols,
  mode: Mode,
  capitalBudgetCents: Count,
})
export type SleeveBinding = typeof Binding.Type

const Exposure = Schema.Struct({ symbol: SymbolSchema, targetCents: Count })
const Outcome = Schema.Struct({
  ...binding,
  verifiedAccountId: Schema.NullOr(AccountId),
  disposition: Schema.Enum(Disposition),
  plan: Schema.NullOr(
    Schema.Struct({
      ...sessions,
      targetExposure: Schema.NullOr(Schema.Array(Exposure)),
      receipt: Schema.Union([CorePlanReceipt, CanaryPlanReceipt]),
    }),
  ),
  error: Schema.NullOr(
    Schema.Struct({ stage: Text, code: Text, cause: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) }),
  ),
})
export type PortfolioOutcome = typeof Outcome.Type

export const PortfolioReceipt = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.multi-account-daily-sleeves-receipt.v1'),
  isolation: Schema.Struct({
    intradayAccountId: AccountId,
    intradayReservedSymbols: Schema.Tuple([Schema.Literal(intradaySymbols[0]), Schema.Literal(intradaySymbols[1])]),
    allowSharedAccount: Bool,
    manifestValidated: Schema.Literal(true),
    allBrokerAccountsVerified: Bool,
    bindings: Schema.Array(Binding),
  }),
  aggregateTargetExposure: Schema.Struct({
    targetCentsBySymbol: Schema.Record(SymbolSchema, Count),
    complete: Bool,
    includedSleeveIds: Schema.Array(SleeveId),
  }),
  sleeves: Schema.Array(Outcome),
  portfolioSha256: Sha256Schema,
})
export type PortfolioReceipt = typeof PortfolioReceipt.Type

const Money = Schema.NullOr(Micros)
const FiniteOrNull = Schema.NullOr(Schema.Finite)
const Distribution = Schema.Struct({ samples: Count, meanBps: FiniteOrNull, medianBps: FiniteOrNull })
const ScorecardReceipt = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.multi-horizon-scorecard.v1'),
  QUALIFICATION_GATE: Schema.Enum(Gate),
  blockingReasons: Schema.Array(Text),
  qualificationSha256: Schema.NullOr(Sha256Schema),
  registeredSessions: Count,
  cleanPaperSessions: Count,
  observedAuditSessions: Count,
  intraday: Schema.Struct({
    cumulativeNetMicros: Money,
    rolling20NetMicros: Money,
    cumulativeRiskAdjustedNetMicros: Money,
    slippage: Schema.Struct({
      ...Distribution.fields,
      promotionBps: Schema.Literal(2.5),
      breakevenBps: Schema.Literal(11.2),
      medianBelowBreakeven: Schema.NullOr(Bool),
      meanBelowBreakeven: Schema.NullOr(Bool),
    }),
    gapThroughCount: Count,
    noAdmissibleCutCount: Count,
    eodStrandedCount: Count,
  }),
  sessions: Schema.Array(
    Schema.Struct({
      date: Date,
      registered: Bool,
      auditSessionSha256: Schema.NullOr(Sha256Schema),
      paperProofSha256: Schema.NullOr(Sha256Schema),
      critical: Schema.Array(Text),
      missing: Schema.Array(Text),
      intradayPeakGrossMicros: Money,
      overnightGrossMicros: Money,
      combinedGrossMicros: Money,
      gapThroughCount: Schema.NullOr(Count),
      noAdmissibleCutCount: Schema.NullOr(Count),
      eodStrandedCount: Schema.NullOr(Count),
      macroCore: Schema.NullOr(
        Schema.Struct({ profile: Schema.Enum(RunnerProfile), mode: CoreReceipt.fields.mode, planSha256: Sha256Schema }),
      ),
      macroCanary: Schema.NullOr(
        Schema.Struct({ profile: Schema.Enum(CanaryProfile), mode: CoreReceipt.fields.mode, planSha256: Sha256Schema }),
      ),
      sip: Schema.Struct({
        gate: Schema.Enum(Gate),
        blockingChecks: Schema.Array(Text),
        observedSymbols: Schema.optionalKey(Count),
        pooledBarCoverage: Schema.optionalKey(Schema.Finite),
        pooledQuoteIngestP95Ms: Schema.optionalKey(FiniteOrNull),
        medianSpreadCompressionBps: Schema.optionalKey(FiniteOrNull),
      }),
      iexSipDrift: AuditReceipt.fields.sessions.value.fields.marketDrift,
      cumulativeNetMicros: Money,
      rolling20NetMicros: Money,
      netMicros: Money,
      riskAdjustedNetMicros: Money,
      slippage: Distribution,
    }),
  ),
})

// These are independently retained, settled account observations. The plan receipt does not prove any fill.
const MacroAccountSession = Schema.Struct({
  accountId: AccountId,
  portfolioSha256: Sha256Schema,
  openingEquityMicros: UnsignedMicros.check(Schema.isPattern(/^[1-9]/)),
  closingEquityMicros: UnsignedMicros,
  netExternalCashFlowMicros: Micros,
  tradedNotionalMicros: UnsignedMicros,
})
export type MacroAccountSession = typeof MacroAccountSession.Type

const AccountEvidence = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.weekly-attribution-evidence.v1'),
  intraday: Schema.optionalKey(Schema.Struct({ accountId: AccountId, auditSha256: Sha256Schema })),
  macroSessions: Schema.Array(MacroAccountSession),
})

export const WeeklyAttributionInput = Schema.Struct({
  audit: AuditReceipt,
  sleeveReceipts: Schema.NonEmptyArray(PortfolioReceipt),
  scorecard: Schema.optionalKey(ScorecardReceipt),
  accountEvidence: Schema.optionalKey(AccountEvidence),
})

export const macroBudgetCents = 1_000_000
const unique = <A>(values: readonly A[]) => new Set(values).size === values.length
const sameSet = <A>(a: readonly A[], b: readonly A[]) =>
  a.length === b.length && unique(a) && a.every((v) => b.includes(v))
const matchesExposure = (actual: Readonly<Record<string, number>>, expected: ReadonlyMap<string, number>) =>
  Object.keys(actual).length === expected.size && [...expected].every(([symbol, value]) => actual[symbol] === value)

const ordersMatch = (
  orders: readonly { readonly request: typeof OrderRequest.Type }[],
  binding: SleeveBinding,
  prefix: string,
) =>
  unique(orders.map(({ request }) => request.symbol)) &&
  orders.every(
    ({ request }) =>
      binding.activeSymbols.includes(request.symbol) && request.client_order_id === `${prefix}${request.symbol}`,
  )

const planHash = (receipt: CorePlanReceipt | CanaryPlanReceipt) => {
  if (receipt.schemaVersion === corePlanVersion) {
    const { planSha256: _digest, mode: _mode, timestamp: _time, ...material } = receipt
    return receiptHash(material)
  }
  const { planSha256: _digest, ...material } = receipt
  return receiptHash(material)
}

const expectedTargets = (
  receipt: CorePlanReceipt | CanaryPlanReceipt,
  binding: SleeveBinding,
): ReadonlyMap<string, number> | null => {
  if (receipt.schemaVersion === corePlanVersion)
    return receipt.allocation.targets === null
      ? null
      : new Map(
          receipt.allocation.targets
            .filter(({ symbol }) => binding.activeSymbols.includes(symbol))
            .map(({ symbol, weight }) => [symbol, Math.floor(weight * receipt.plan.budgetCents)]),
        )
  if (!receipt.target.review && receipt.resumedRotation === null) return null
  return new Map(
    macroCanaryEtfs
      .filter((symbol) => binding.activeSymbols.includes(symbol))
      .map((symbol) => [symbol, Math.floor(receipt.effectiveTargetWeights[symbol] * receipt.budgetCents)]),
  )
}

export const verifyPortfolio = ({ portfolioSha256, ...material }: PortfolioReceipt, index: number) =>
  Result.gen(function* () {
    const reject = (message: string, kind: string) =>
      Result.fail(attributionError(`Sleeve receipt #${index + 1}: ${message}`, { kind, index }))
    const { isolation, sleeves, aggregateTargetExposure } = material
    const { intradayAccountId, bindings } = isolation
    if ((yield* receiptHash(material)) !== portfolioSha256)
      return yield* reject('portfolio SHA-256 mismatch', 'DigestMismatch')

    const coreBinding = bindings.find(({ strategy }) => strategy === Strategy.MacroEtfCore)
    const canaryBinding = bindings.find(({ strategy }) => strategy === Strategy.MacroCanaryEtf)
    if (
      isolation.allowSharedAccount ||
      bindings.length !== 2 ||
      coreBinding === undefined ||
      canaryBinding === undefined ||
      !unique([intradayAccountId, coreBinding.accountId, canaryBinding.accountId]) ||
      coreBinding.sleeveId === canaryBinding.sleeveId
    )
      return yield* reject('three distinct, isolated account bindings are required', 'AccountCollision')

    const core = sleeves.find(({ sleeveId }) => sleeveId === coreBinding.sleeveId)
    const canary = sleeves.find(({ sleeveId }) => sleeveId === canaryBinding.sleeveId)
    if (sleeves.length !== 2 || core === undefined || canary === undefined)
      return yield* reject('outcomes do not match the sleeve bindings', 'SleeveBindingMismatch')

    const corePlan = core.plan?.receipt
    const canaryPlan = canary.plan?.receipt
    if (
      coreBinding.profile !== RunnerProfile.F4 ||
      canaryBinding.profile !== CanaryProfile.O1 ||
      (corePlan !== undefined && corePlan.schemaVersion !== corePlanVersion) ||
      (canaryPlan !== undefined && canaryPlan.schemaVersion !== canaryPlanVersion)
    )
      return yield* reject('expected the F4 core and O1 canary plans', 'SleeveProfileMismatch')

    const activeSessions = new Set<string>()
    const included = []
    const exposure = new Map<string, number>()
    for (const [binding, outcome, symbols] of [
      [coreBinding, core, universe],
      [canaryBinding, canary, macroCanaryEtfs],
    ] as const) {
      const { accountId, verifiedAccountId, disposition, plan, error } = outcome
      if (accountId !== binding.accountId || (verifiedAccountId !== null && verifiedAccountId !== accountId))
        return yield* reject('outcome account ID does not match its binding', 'AccountMismatch')
      if (
        binding.capitalBudgetCents !== macroBudgetCents ||
        binding.activeSymbols.length === 0 ||
        !unique(binding.excludeSymbols) ||
        !sameSet(
          binding.activeSymbols,
          symbols.filter((symbol) => !binding.excludeSymbols.includes(symbol)),
        )
      )
        return yield* reject('invalid $10k sleeve budget or symbol scope', 'InvalidSleeveBinding')

      if ((disposition === Disposition.Failed) !== (error !== null) || (plan === null && error === null))
        return yield* reject('outcome and failure evidence disagree', 'InvalidDisposition')
      if (plan === null) continue
      const { receipt, signalSession, executionSession, targetExposure } = plan
      if (
        verifiedAccountId === null ||
        receipt.mode !== binding.mode ||
        receipt.signalSession !== signalSession ||
        receipt.executionSession !== executionSession ||
        signalSession >= executionSession
      )
        return yield* reject('plan does not match the verified account or session', 'InvalidPlanBinding')

      if ((yield* planHash(receipt)) !== receipt.planSha256)
        return yield* reject('sleeve plan SHA-256 mismatch', 'DigestMismatch')

      const orders = receipt.schemaVersion === corePlanVersion ? receipt.plan.orders : receipt.orders
      const prefix = receipt.schemaVersion === corePlanVersion ? coreOrderPrefix : canaryOrderPrefix
      if (!ordersMatch(orders, binding, prefix(accountId, executionSession)))
        return yield* reject('order identity or symbol is outside its account binding', 'OrderBindingMismatch')
      if (
        disposition !== Disposition.Failed &&
        (binding.mode === SleeveMode.Shadow
          ? disposition !== Disposition.Shadow
          : orders.length === 0
            ? disposition !== Disposition.NoOrders
            : disposition !== Disposition.Submitted && disposition !== Disposition.Withheld)
      )
        return yield* reject('disposition does not match mode and orders', 'InvalidDisposition')

      activeSessions.add(`${signalSession}/${executionSession}`)
      const expected = expectedTargets(receipt, binding)
      if (targetExposure === null && expected === null) continue
      if (
        targetExposure === null ||
        expected === null ||
        targetExposure.length !== expected.size ||
        !unique(targetExposure.map(({ symbol }) => symbol)) ||
        targetExposure.some(({ symbol, targetCents }) => expected.get(symbol) !== targetCents)
      )
        return yield* reject('target exposure does not match its sleeve allocation and budget', 'InvalidExposure')
      included.push(binding.sleeveId)
      for (const { symbol, targetCents } of targetExposure)
        exposure.set(symbol, (exposure.get(symbol) ?? 0) + targetCents)
    }
    if (activeSessions.size > 1) return yield* reject('sleeves have different sessions', 'SessionMismatch')
    if (
      isolation.allBrokerAccountsVerified !==
        sleeves.every(({ accountId, verifiedAccountId }) => accountId === verifiedAccountId) ||
      aggregateTargetExposure.complete !== sleeves.every(({ error }) => error === null) ||
      !sameSet(aggregateTargetExposure.includedSleeveIds, included) ||
      !matchesExposure(aggregateTargetExposure.targetCentsBySymbol, exposure)
    )
      return yield* reject('aggregate evidence does not match its outcomes', 'InvalidPortfolioSummary')

    if (
      corePlan !== undefined &&
      (corePlan.profile !== RunnerProfile.F4 ||
        corePlan.configuredBudgetCents !== macroBudgetCents ||
        corePlan.plan.budgetCents > macroBudgetCents ||
        !sameSet(corePlan.configuredExclusions, coreBinding.excludeSymbols) ||
        corePlan.plan.reviewDue !== (corePlan.allocation.targets !== null) ||
        !corePlan.signalCloseAt.startsWith(corePlan.signalSession) ||
        !corePlan.executionOpenAt.startsWith(corePlan.executionSession) ||
        compareAt(corePlan.signalCloseAt, corePlan.timestamp) >= 0 ||
        compareAt(corePlan.timestamp, corePlan.executionOpenAt) >= 0)
    )
      return yield* reject('invalid F4 sizing or observation cut', 'InvalidCorePlan')

    if (canaryPlan !== undefined) {
      const { accountId, sleeveId, capitalBudgetCents, activeSymbols } = canaryBinding
      const { target, signalSession, executionSession, resumedRotation, phase, holdReason, orders } = canaryPlan
      if (canaryPlan.sleeveSha256 !== (yield* receiptHash({ accountId, sleeveId, capitalBudgetCents, activeSymbols })))
        return yield* reject('canary plan belongs to a different sleeve binding', 'AccountMismatch')
      const actionable = target.review || resumedRotation !== null
      if (
        canaryPlan.budgetCents > macroBudgetCents ||
        target.signalSession !== signalSession ||
        target.nextOpenSession !== executionSession ||
        (resumedRotation !== null && (target.review || resumedRotation.signalSession >= signalSession)) ||
        (phase === RotationPhase.Hold
          ? orders.length !== 0 || holdReason === null
          : orders.length === 0 || holdReason !== null) ||
        actionable === (holdReason === HoldReason.OutsideReview) ||
        actionable !== (canaryPlan.remainingOneWayTurnoverBps !== null)
      )
        return yield* reject('invalid O1 phase or review binding', 'InvalidRotation')
    }

    return {
      intradayAccountId,
      portfolioSha256,
      date: corePlan?.executionSession ?? canaryPlan?.executionSession,
      core: { binding: coreBinding, outcome: core, plan: corePlan },
      canary: { binding: canaryBinding, outcome: canary, plan: canaryPlan },
    }
  })
