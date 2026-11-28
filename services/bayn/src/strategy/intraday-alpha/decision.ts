import { Result, Schema } from 'effect'

import { OrderSide } from '../../execution/contracts'
import { canonicalHashV1Result } from '../../hash'
import { JevContractError } from '../../jev/contract'
import { positionProtectionIntervalMs } from '../../jev/exit-policy'
import { JevPurpose } from '../../jev/portfolio'
import { quantityScale } from '../../quantity'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import type { TargetPlanResult } from '../../target-planner/result'
import type { StrategyDefinition } from '../core'
import { CatalystVetoReceiptSchema } from './catalyst-veto'
import {
  IntradayAlphaLongFundedExitPlanSchema,
  IntradayAlphaShortFundedExitPlanSchema,
  makeIntradayAlphaFundedExitPlan,
  type IntradayAlphaFundedExitPlan,
} from './exit-plan'
import { IntradayAlphaObservationSchema, reproduceIntradayAlphaObservation } from './observation'
import {
  IntradayAlphaPhase,
  alphaObservationVersion,
  isPureEtfPolicy,
  IntradayAlphaPolicySchema,
  IntradayAlphaSetup,
  type IntradayAlphaPolicy,
  type IntradayAlphaPolicyMaterial,
} from './policy'
import { extractIntradayAlphaCandidates, resolveAlphaRegularSession, selectIntradayAlphaLegs } from './signals'

/** Compare executable quantities using the same adverse quote prices that size the legs. */
export const isBalancedMiddayBasket = (
  plan: Pick<TargetPlanResult, 'intentTargets' | 'targets'>,
  selectedSymbols: readonly string[],
): boolean => {
  if (selectedSymbols.length <= 1 || plan.intentTargets.length === 0) return true
  if (!selectedSymbols.every((symbol) => plan.intentTargets.some((intent) => intent.symbol === symbol))) return false

  let longNotional = 0n
  let shortNotional = 0n
  let longShareRounding = 0n
  let shortShareRounding = 0n
  for (const intent of plan.intentTargets) {
    const price = plan.targets.find((target) => target.symbol === intent.symbol)?.referencePriceMicros
    if (price === undefined || !selectedSymbols.includes(intent.symbol)) return false
    const priceMicros = BigInt(price)
    const notional = priceMicros * BigInt(intent.quantityAtoms)
    if (intent.side === OrderSide.Buy) {
      longNotional += notional
      longShareRounding += priceMicros * quantityScale
    } else {
      shortNotional += notional
      shortShareRounding += priceMicros * quantityScale
    }
  }

  // Each leg can lose less than one share when the planner rounds its allocation down.
  return (
    longNotional > 0n &&
    shortNotional > 0n &&
    longNotional - shortNotional <= shortShareRounding &&
    shortNotional - longNotional <= longShareRounding
  )
}

/** Keep the first funded pairs in selection order, or a single funded leg if only one side remains. */
export const balancedFundedMiddaySymbols = (
  symbols: readonly string[],
  weights: Readonly<Record<string, number>>,
): readonly string[] => {
  if (symbols.length <= 1) return symbols
  const longs = symbols.filter((symbol) => (weights[symbol] ?? 0) > 0)
  const shorts = symbols.filter((symbol) => (weights[symbol] ?? 0) < 0)
  if (longs.length === shorts.length) return symbols
  const pairs = Math.min(longs.length, shorts.length)
  if (pairs === 0) return symbols.slice(0, 1)
  const keep = new Set([...longs.slice(0, pairs), ...shorts.slice(0, pairs)])
  return symbols.filter((symbol) => keep.has(symbol))
}

export enum IntradayAlphaDecisionReason {
  SelectedMorningOrb = 'SELECTED_MORNING_ORB',
  SelectedMiddayReversion = 'SELECTED_MIDDAY_REVERSION',
  SelectedNoiseArea = 'SELECTED_NOISE_AREA',
  OutsideWindow = 'OUTSIDE_PHASE_WINDOW',
  NoSignal = 'NO_ELIGIBLE_ALPHA_SIGNAL',
  AllVetoed = 'ALL_CANDIDATES_VETOED',
  Unfunded = 'SELECTED_LEGS_UNFUNDED',
}

export const IntradayAlphaDecisionEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-evidence.v2'),
  observation: IntradayAlphaObservationSchema,
  morningOrbTakenSymbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  middayReversionCompleted: Schema.Boolean,
  noiseAreaTakenSymbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  catalystVetos: Schema.Array(CatalystVetoReceiptSchema),
  decidedAt: UtcInstantSchema,
})
export type IntradayAlphaDecisionEvidence = typeof IntradayAlphaDecisionEvidenceSchema.Type

export const IntradayAlphaSignalRecordSchema = Schema.Struct({
  symbol: SymbolSchema,
  phase: Schema.Literals([
    IntradayAlphaPhase.MorningOrb,
    IntradayAlphaPhase.MiddayReversion,
    IntradayAlphaPhase.NoiseAreaTrend,
  ]),
  setup: Schema.Enum(IntradayAlphaSetup),
  direction: Schema.Literals(['LONG', 'SHORT']),
  scoreBps: Schema.Finite,
  relVwapDevBps: Schema.Finite,
  vetoed: Schema.Boolean,
})

const AlphaExitPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.position-exit-policy.v5'),
  maximumPriceCheckIntervalMs: Schema.Literal(positionProtectionIntervalMs),
  maximumHoldingMinutes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(390)),
  plans: Schema.Record(
    SymbolSchema,
    Schema.Union([IntradayAlphaLongFundedExitPlanSchema, IntradayAlphaShortFundedExitPlanSchema]),
  ),
})

export const deriveIntradayAlphaTargetMaterial = <Policy extends IntradayAlphaPolicyMaterial>(
  policy: Policy,
  evidence: IntradayAlphaDecisionEvidence,
  observation: Result.Result.Success<ReturnType<typeof reproduceIntradayAlphaObservation>>,
) =>
  Result.gen(function* () {
    const protocol = policy.sharedProtocol
    const decided = Date.parse(evidence.decidedAt)
    const hours = observation.snapshot.manifest.calendar
    const regularSession = resolveAlphaRegularSession(hours, observation.snapshot.manifest.sessionDate)
    if (
      observation.schemaVersion !== alphaObservationVersion(policy) ||
      (isPureEtfPolicy(policy) && evidence.catalystVetos.length > 0) ||
      observation.portfolio.purpose !== JevPurpose.Entry ||
      (yield* canonicalHashV1Result(protocol)) !== (yield* canonicalHashV1Result(observation.protocol)) ||
      decided < Date.parse(observation.observedAt) ||
      decided >= Date.parse(observation.observedAt) + protocol.inferenceValidityMs ||
      Result.isFailure(regularSession) ||
      decided >= regularSession.success.closeMs - protocol.entryCutoffMinutesBeforeClose * 60_000
    )
      return yield* Result.fail(
        new JevContractError({
          message: 'Intraday alpha decision differs from its entry source, protocol or original deadline',
        }),
      )

    const occupiedSymbols = observation.portfolio.brokerState.positions
      .filter((position) => BigInt(position.quantityAtoms) !== 0n)
      .map((position) => position.symbol)
      .toSorted()

    const extracted = yield* extractIntradayAlphaCandidates({
      snapshot: observation.snapshot,
      policy,
      trailingBaseline: observation.trailingBaseline,
      accountId: observation.portfolio.brokerState.account.accountId,
      ...(observation.equityShortEligibility === undefined
        ? {}
        : { equityShortEligibility: observation.equityShortEligibility }),
      occupiedSymbols,
      morningOrbTakenSymbols: evidence.morningOrbTakenSymbols,
      middayReversionCompleted: evidence.middayReversionCompleted,
      noiseAreaTakenSymbols: evidence.noiseAreaTakenSymbols,
    })

    const vetoedSymbols = new Set(
      evidence.catalystVetos.filter((receipt) => receipt.vetoed).map((receipt) => receipt.symbol),
    )

    const chosenLegs = selectIntradayAlphaLegs({
      context: extracted.context,
      policy,
      longPool: extracted.longPool,
      shortPool: extracted.shortPool,
      vetoedSymbols,
    })

    const plans: Record<string, IntradayAlphaFundedExitPlan> = {}
    const weights: Record<string, number> = Object.fromEntries(policy.candidateSymbols.map((symbol) => [symbol, 0]))
    const selectedSymbols: string[] = []
    let maximumHoldingMinutes = protocol.maximumHoldingMinutes

    for (const leg of chosenLegs) {
      if (occupiedSymbols.includes(leg.symbol)) continue
      const funded = yield* makeIntradayAlphaFundedExitPlan({ policy, observation, leg })
      if (funded === null) continue
      plans[leg.symbol] = funded.plan
      weights[leg.symbol] = funded.signedWeight
      selectedSymbols.push(leg.symbol)
      if (leg.maximumHoldingMinutes > maximumHoldingMinutes) maximumHoldingMinutes = leg.maximumHoldingMinutes
    }

    // For paired midday reversion, preserve dollar-neutrality when one leg fails funding:
    // if at least 1 long and 1 short funded, pair equal counts; otherwise retain single funded extreme.
    if (extracted.context.phase === IntradayAlphaPhase.MiddayReversion && selectedSymbols.length > 1) {
      const balanced = balancedFundedMiddaySymbols(selectedSymbols, weights)
      for (const symbol of selectedSymbols) {
        if (!balanced.includes(symbol)) {
          delete plans[symbol]
          weights[symbol] = 0
        }
      }
      selectedSymbols.splice(0, selectedSymbols.length, ...balanced)
    }

    selectedSymbols.sort()
    const totalCandidates = extracted.longPool.length + extracted.shortPool.length
    const reason =
      extracted.context.phase === IntradayAlphaPhase.OutsideWindow
        ? IntradayAlphaDecisionReason.OutsideWindow
        : totalCandidates === 0
          ? IntradayAlphaDecisionReason.NoSignal
          : chosenLegs.length === 0
            ? IntradayAlphaDecisionReason.AllVetoed
            : selectedSymbols.length === 0
              ? IntradayAlphaDecisionReason.Unfunded
              : extracted.context.phase === IntradayAlphaPhase.MorningOrb
                ? IntradayAlphaDecisionReason.SelectedMorningOrb
                : extracted.context.phase === IntradayAlphaPhase.NoiseAreaTrend
                  ? IntradayAlphaDecisionReason.SelectedNoiseArea
                  : IntradayAlphaDecisionReason.SelectedMiddayReversion

    const signals = [...extracted.longPool, ...extracted.shortPool]
      .map((candidate) => ({
        symbol: candidate.symbol,
        phase: candidate.phase,
        setup: candidate.setup,
        direction: candidate.direction,
        scoreBps: Number(candidate.scoreBps.toFixed(4)),
        relVwapDevBps: Number(candidate.relVwapDevBps.toFixed(4)),
        vetoed: vetoedSymbols.has(candidate.symbol),
      }))
      .toSorted((a, b) => a.symbol.localeCompare(b.symbol) || a.direction.localeCompare(b.direction))

    const material = {
      strategy: 'jev' as const,
      policy,
      evidence,
      phase: extracted.context.phase,
      reason,
      sessionDate: yield* Schema.decodeUnknownResult(IsoDateSchema)(observation.snapshot.manifest.sessionDate),
      snapshotId: observation.snapshot.manifest.snapshotId,
      observedAt: observation.observedAt,
      decidedAt: evidence.decidedAt,
      calendarHash: yield* canonicalHashV1Result(hours),
      signals,
      selectedSymbols,
      targetWeights: weights,
      exitPolicy: {
        schemaVersion: 'bayn.position-exit-policy.v5' as const,
        maximumPriceCheckIntervalMs: positionProtectionIntervalMs,
        maximumHoldingMinutes,
        plans,
      },
    }
    return isPureEtfPolicy(policy)
      ? { ...material, schemaVersion: 'bayn.intraday-alpha-target.v3' as const }
      : { ...material, schemaVersion: 'bayn.intraday-alpha-target.v2' as const }
  })

const deriveIntradayAlphaTarget = (policy: IntradayAlphaPolicy, evidence: IntradayAlphaDecisionEvidence) =>
  reproduceIntradayAlphaObservation(evidence.observation).pipe(
    Result.flatMap((observation) => deriveIntradayAlphaTargetMaterial(policy, evidence, observation)),
  )

export const decideIntradayAlphaEntry = (input: unknown, policy: IntradayAlphaPolicy) =>
  Result.gen(function* () {
    const verifiedPolicy = yield* Schema.decodeUnknownResult(IntradayAlphaPolicySchema, strictParseOptions)(policy)
    const evidence = yield* Schema.decodeUnknownResult(IntradayAlphaDecisionEvidenceSchema, strictParseOptions)(input)
    return yield* deriveIntradayAlphaTarget(verifiedPolicy, evidence)
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Intraday alpha target could not be derived', cause })),
  )

const alphaTargetFields = {
  strategy: Schema.Literal('jev'),
  policy: IntradayAlphaPolicySchema,
  evidence: IntradayAlphaDecisionEvidenceSchema,
  phase: Schema.Enum(IntradayAlphaPhase),
  reason: Schema.Enum(IntradayAlphaDecisionReason),
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  decidedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  signals: Schema.Array(IntradayAlphaSignalRecordSchema),
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isMaxLength(4), Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }))),
  exitPolicy: AlphaExitPolicySchema,
}
const AlphaV2TargetSchema = Schema.Struct({
  ...alphaTargetFields,
  schemaVersion: Schema.Literal('bayn.intraday-alpha-target.v2'),
})
const PureEtfTargetSchema = Schema.Struct({
  ...alphaTargetFields,
  schemaVersion: Schema.Literal('bayn.intraday-alpha-target.v3'),
})
export const IntradayAlphaTargetSchema = Schema.Union([AlphaV2TargetSchema, PureEtfTargetSchema]).check(
  Schema.makeFilter((target) => {
    const reproduced = deriveIntradayAlphaTarget(target.policy, target.evidence).pipe(
      Result.flatMap(canonicalHashV1Result),
    )
    const observed = canonicalHashV1Result(target)
    return Result.isSuccess(reproduced) && Result.isSuccess(observed) && reproduced.success === observed.success
      ? []
      : [{ path: [], issue: 'intraday alpha target must reproduce its complete policy and causal source' }]
  }),
)
export type IntradayAlphaTarget = typeof IntradayAlphaTargetSchema.Type

export const makeIntradayAlphaDefinition = (
  policy: IntradayAlphaPolicy,
): StrategyDefinition<IntradayAlphaDecisionEvidence, JevContractError, IntradayAlphaTarget, IntradayAlphaPolicy> => ({
  name: 'jev',
  holdingPeriod: 'INTRADAY',
  parameters: policy,
  decide: ({ market }) => decideIntradayAlphaEntry(market, policy),
})
