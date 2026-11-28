import { exchangeSessions } from '../market-hours'
import { jevMarketForSymbol } from './markets'
import { isContinuousMarket } from '../market-hours'
import { Result, Schema } from 'effect'

import { canonicalJsonEqualV1 } from '../hash'
import { maximumBrokerObservationAgeMs } from '../broker/alpaca/observed-snapshot'
import { resolveAlphaRegularSession, noiseAreaBands } from '../strategy/intraday-alpha/signals'
import { pureEtfCheckpointMinutes } from '../market-data/intraday/trailing-baseline'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import type { IntradayQuote } from '../market-data/intraday/model'
import { intradayAgeNanos, millisecondsAsNanos } from '../market-data/intraday/time'
import { reproduceStrategySnapshot } from '../market-data/streaming/replay'
import { IsoDateSchema, Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { JevContractError } from './contract'
import { jevPositionExitPolicy } from './exit-policy'
import { jevProfitTargetCrossed } from './profit-target'
import { JevObservationSchema } from './observation-contract'
import { JevPortfolioSchema, JevPurpose, jevManagedExitPlan } from './portfolio'
import type { JevStrategyExitPlan } from './strategy-exit-plan'
import { JevProtocolSchema } from './protocol'
import { isIntradayAlphaExitPlan, isShortExitPlan } from '../strategy/funded-exit-plan'
import { intradayAlphaCandidateSymbols } from '../strategy/intraday-alpha/constants'

export enum JevExitReason {
  ProfitTarget = 'PROFIT_TARGET',
  MaximumHold = 'MAXIMUM_HOLD',
  ProtectiveStop = 'PROTECTIVE_STOP',
  ProtectionReleased = 'PROTECTION_RELEASED',
  OppositeBandExit = 'OPPOSITE_BAND_EXIT',
}

const TriggerSchema = Schema.Union([
  Schema.Struct({ reason: Schema.Literals([JevExitReason.MaximumHold, JevExitReason.ProtectionReleased]) }),
  Schema.Struct({
    reason: Schema.Literals([JevExitReason.ProtectiveStop, JevExitReason.ProfitTarget, JevExitReason.OppositeBandExit]),
    manifest: JevObservationSchema.fields.manifest,
    rows: JevObservationSchema.fields.rows,
  }),
])

export const JevPositionEvidenceSchema = Schema.Struct({
  cycleId: Sha256Schema,
  sessionDate: IsoDateSchema,
  protocol: JevProtocolSchema,
  portfolio: JevPortfolioSchema,
  observedAt: UtcInstantSchema,
  symbol: Schema.optionalKey(SymbolSchema),
})
export const JevExitEvidenceSchema = Schema.Struct({
  ...JevPositionEvidenceSchema.fields,
  trigger: TriggerSchema,
})
export type JevExitEvidence = typeof JevExitEvidenceSchema.Type

/** Pure exit arithmetic needs these policy facts; admission still decodes the complete current protocol. */
export type JevExitEvidenceMaterial = Omit<JevExitEvidence, 'protocol'> & {
  readonly protocol: Pick<
    JevExitEvidence['protocol'],
    'candidateSymbols' | 'maximumHoldingMinutes' | 'maximumQuoteAgeMs'
  > &
    Partial<Pick<JevExitEvidence['protocol'], 'marketProfiles'>>
}

const invalid = (message: string) => Result.fail(new JevContractError({ message }))
export const jevProtectiveQuoteIsFresh = (
  quote: Pick<IntradayQuote, 'eventAt'>,
  observedAt: string,
  maximumAgeMs: number,
): boolean => {
  const age = intradayAgeNanos(observedAt, quote.eventAt)
  return age >= 0n && age <= millisecondsAsNanos(maximumAgeMs)
}

export const jevProtectiveStopCrossed = (
  bidMicros: bigint,
  plan: Pick<JevStrategyExitPlan, 'stopPriceMicros'> & { readonly positionSide?: 'SHORT' },
): boolean =>
  plan.positionSide === 'SHORT' ? bidMicros >= BigInt(plan.stopPriceMicros) : bidMicros <= BigInt(plan.stopPriceMicros)
export const jevMaximumHoldDueAt = (firstFillAt: string, maximumHoldingMinutes: number): string =>
  new Date(Date.parse(firstFillAt) + maximumHoldingMinutes * 60_000).toISOString()
export const jevBrokerEvidenceFreshUntilMs = (state: {
  readonly account: { readonly observedAt: string }
  readonly positionsObservedAt: string
  readonly ordersObservedAt: string
  readonly reconciliation: { readonly reconciledAt: string }
}): number =>
  Math.min(
    Date.parse(state.account.observedAt),
    Date.parse(state.positionsObservedAt),
    Date.parse(state.ordersObservedAt),
    Date.parse(state.reconciliation.reconciledAt),
  ) + maximumBrokerObservationAgeMs
const equal = canonicalJsonEqualV1

type PriceExitSource = {
  readonly manifest: unknown
  readonly rows: typeof JevObservationSchema.fields.rows.Type
}

/** Reproduce source identity and prices without treating transient quote availability as a contract failure. */
export const reproducePositionQuote = (
  input: Pick<JevExitEvidenceMaterial, 'protocol' | 'sessionDate' | 'observedAt'> & {
    readonly symbol: string
    readonly positionSide?: 'SHORT'
    readonly checkpoint?: true
  },
  source: PriceExitSource,
) =>
  Result.gen(function* () {
    const snapshot = yield* reproduceStrategySnapshot(source.manifest, source.rows)
    const { protocol, sessionDate, observedAt, symbol } = input
    const m = snapshot.manifest
    const market = jevMarketForSymbol(
      symbol,
      protocol.marketProfiles?.find((profile) => profile.feed === m.feed)?.universeId ?? m.universeId,
    )
    const end = Math.floor(Date.parse(observedAt) / 60_000) * 60_000
    const session = isContinuousMarket(m.calendar)
      ? undefined
      : exchangeSessions(m.calendar).find(({ date }) => date === sessionDate)
    if (
      m.purpose !==
        (input.checkpoint === true
          ? IntradaySnapshotPurpose.PositionCheckpoint
          : IntradaySnapshotPurpose.Liquidation) ||
      m.observedAt !== observedAt ||
      m.sessionDate !== sessionDate ||
      m.symbols.length !== 1 ||
      m.symbols[0] !== symbol ||
      m.universeId !== market.universeId ||
      m.universeSymbolHash !== market.universeSymbolHash ||
      !equal(m.universe, market.universe) ||
      m.feed !== market.feed ||
      m.delayClass !== market.delayClass ||
      !equal(m.sourceTopics, market.sourceTopics) ||
      m.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
      Date.parse(m.rangeEndAt) !== end ||
      Date.parse(m.rangeStartAt) !== end - 60_000 ||
      (!isContinuousMarket(m.calendar) &&
        (session === undefined || m.rangeStartAt < session.openAt || observedAt >= session.closeAt))
    )
      return yield* invalid('Price exit requires a fresh reproduced liquidation quote from the exact market source')
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) return yield* invalid('Price exit has no fresh executable bid')
    const bid = yield* priceNumberToMicros(quote.bidPrice, 'bid', 'DOWN')
    const ask = yield* priceNumberToMicros(quote.askPrice, 'ask', 'UP')
    return { bid, ask, quote, snapshot }
  })

export const verifiedPositionQuote = (input: Parameters<typeof reproducePositionQuote>[0], source: PriceExitSource) =>
  Result.gen(function* () {
    const evidence = yield* reproducePositionQuote(input, source)
    const { quote } = evidence
    if (
      (input.positionSide === 'SHORT' ? quote.askSize <= 0 : quote.bidSize <= 0) ||
      !jevProtectiveQuoteIsFresh(quote, input.observedAt, input.protocol.maximumQuoteAgeMs)
    )
      return yield* invalid('Price exit has no fresh executable bid')
    return evidence
  })

export const validateJevPositionEvidence = (evidence: Omit<JevExitEvidenceMaterial, 'trigger'>) =>
  Result.gen(function* () {
    const { portfolio, protocol } = evidence
    if (portfolio.purpose !== JevPurpose.Manage) return yield* invalid('Exit requires an accounted held position')
    if (portfolio.managedSymbol !== undefined && portfolio.managedSymbol !== evidence.symbol)
      return yield* invalid('Position evidence must manage the exact bound ETF leg')
    const state = portfolio.brokerState
    const position =
      evidence.symbol === undefined
        ? (state.positions.find(
            (entry) => BigInt(entry.quantityAtoms) !== 0n && entry.symbol in portfolio.exitPolicy.plans,
          ) ?? state.positions.find(({ quantityAtoms }) => BigInt(quantityAtoms) !== 0n))
        : state.positions.find((entry) => entry.symbol === evidence.symbol && BigInt(entry.quantityAtoms) !== 0n)
    const entryPlan = yield* jevManagedExitPlan(portfolio, evidence.symbol ?? position?.symbol)
    const alphaPlan = isIntradayAlphaExitPlan(entryPlan)
    if (!alphaPlan && !equal(portfolio.exitPolicy, jevPositionExitPolicy(protocol, portfolio.exitPolicy.plans)))
      return yield* invalid('Exit policy differs from the policy sealed into the entry decision')
    const symbolFills =
      position === undefined ? [] : portfolio.entryFills.filter((fill) => fill.symbol === position.symbol)
    const firstFill = symbolFills[0] ?? portfolio.entryFills[0]
    if (position === undefined || firstFill === undefined)
      return yield* invalid('Exit requires a long position with cost basis and its first fill')
    const market = jevMarketForSymbol(position.symbol)
    const now = Date.parse(evidence.observedAt)
    const symbolAllowed = alphaPlan
      ? intradayAlphaCandidateSymbols.some((candidate) => candidate === position.symbol)
      : protocol.candidateSymbols.includes(position.symbol)
    if (
      !symbolAllowed ||
      (market.feed !== 'us' &&
        (firstFill.occurredAt.slice(0, 10) !== evidence.sessionDate ||
          evidence.observedAt.slice(0, 10) !== evidence.sessionDate)) ||
      [
        state.account.observedAt,
        state.positionsObservedAt,
        state.ordersObservedAt,
        state.reconciliation.reconciledAt,
      ].some((at) => Date.parse(at) > now) ||
      now >= jevBrokerEvidenceFreshUntilMs(state)
    )
      return yield* invalid('Exit requires current position evidence for its strategy session')
    return { portfolio, position, firstFill, entryPlan, now }
  })

/** A zero width is a real observation: the gap-aware open and prior close remain the bands. */
export const oppositeAlphaBandCrossed = (
  snapshot: import('../market-data/streaming/snapshot').StrategyMarketSnapshot,
  plan: import('../strategy/intraday-alpha/exit-plan').IntradayAlphaFundedExitPlan,
) =>
  Result.gen(function* () {
    const { fillAnchored, symbol } = plan.levels
    if (fillAnchored === undefined) return false
    const { calendar, sessionDate, rangeEndAt } = snapshot.manifest
    const regular = yield* resolveAlphaRegularSession(calendar, sessionDate)
    const end = Date.parse(rangeEndAt)
    const minute = (end - regular.openMs) / 60_000
    if (
      !pureEtfCheckpointMinutes.some((cp) => cp === minute) ||
      end > regular.closeMs - 30 * 60_000 ||
      rangeEndAt <= plan.levels.sourceEndAt
    )
      return false
    const width = fillAnchored.checkpointSwings[String(minute)]
    if (width === undefined) return false
    const bar = snapshot.bars.find((record) => record.symbol === symbol && Date.parse(record.eventAt) === end - 60_000)
    if (bar === undefined || intradayAgeNanos(bar.ingestedAt, bar.eventAt) < millisecondsAsNanos(60_000))
      return yield* invalid('Opposite-band exit requires the completed checkpoint bar')
    const { upperBand, lowerBand } = noiseAreaBands(
      fillAnchored.sessionOpen,
      fillAnchored.previousClose,
      width,
      fillAnchored.bandMultiplier,
    )
    return isShortExitPlan(plan) ? bar.close > upperBand : bar.close < lowerBand
  })

export const deriveJevExitTargetMaterial = <Evidence extends JevExitEvidenceMaterial>(evidence: Evidence) =>
  Result.gen(function* () {
    const { protocol, trigger } = evidence
    const { portfolio, position, firstFill, entryPlan, now } = yield* validateJevPositionEvidence(evidence)
    let commitDeadlineAt = new Date(now + protocol.maximumQuoteAgeMs).toISOString()
    switch (trigger.reason) {
      case JevExitReason.ProtectionReleased:
        if (portfolio.exitRequestedAt === null || portfolio.exitRequestedAt > evidence.observedAt)
          return yield* invalid('Protection release requires a durable exit request or an accounted protective fill')
        break
      case JevExitReason.MaximumHold:
        if (now < Date.parse(firstFill.occurredAt) + entryPlan.levels.maximumHoldingMinutes * 60_000)
          return yield* invalid('Maximum holding time has not elapsed since the actual first fill')
        break
      case JevExitReason.ProtectiveStop:
      case JevExitReason.ProfitTarget:
      case JevExitReason.OppositeBandExit: {
        const short = isShortExitPlan(entryPlan)
        const { bid, ask, quote, snapshot } = yield* verifiedPositionQuote(
          {
            ...evidence,
            symbol: position.symbol,
            ...(short ? { positionSide: 'SHORT' as const } : {}),
            ...(trigger.reason === JevExitReason.OppositeBandExit ? { checkpoint: true as const } : {}),
          },
          trigger,
        )
        const exitPrice = short ? ask : bid
        const crossed =
          trigger.reason === JevExitReason.ProtectiveStop
            ? jevProtectiveStopCrossed(exitPrice, entryPlan.levels)
            : trigger.reason === JevExitReason.OppositeBandExit
              ? portfolio.managedSymbol === position.symbol &&
                isIntradayAlphaExitPlan(entryPlan) &&
                (yield* oppositeAlphaBandCrossed(snapshot, entryPlan))
              : yield* jevProfitTargetCrossed(portfolio, exitPrice, position.symbol)
        if (!crossed) return yield* invalid('The verified bid has not crossed its entry-bound exit threshold')
        commitDeadlineAt = new Date(Date.parse(quote.eventAt) + protocol.maximumQuoteAgeMs).toISOString()
        break
      }
    }
    return {
      schemaVersion: 'bayn.jev-exit-target.v5' as const,
      strategyName: 'jev' as const,
      cycleId: evidence.cycleId,
      entryDecisionHash: portfolio.entryDecisionHash,
      sessionDate: evidence.sessionDate,
      symbols: [position.symbol],
      targetWeights: { [position.symbol]: 0 as const },
      reason: trigger.reason,
      observedAt: evidence.observedAt,
      commitDeadlineAt,
      evidence,
    }
  }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev exit evidence does not reproduce', cause })))

export const decideJevExit = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevExitEvidenceSchema,
    strictParseOptions,
  )(input).pipe(
    Result.flatMap(deriveJevExitTargetMaterial),
    Result.mapError((cause) => new JevContractError({ message: 'Jev exit evidence does not reproduce', cause })),
  )

export const JevExitTargetSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-exit-target.v5'),
  strategyName: Schema.Literal('jev'),
  cycleId: Sha256Schema,
  entryDecisionHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  targetWeights: Schema.Record(SymbolSchema, Schema.Literal(0)),
  reason: Schema.Enum(JevExitReason),
  observedAt: UtcInstantSchema,
  commitDeadlineAt: UtcInstantSchema,
  evidence: JevExitEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = decideJevExit(target.evidence)
    return Result.isSuccess(reproduced) && equal(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'the complete exit evidence must reproduce the exact flat target' }]
  }),
)
export type JevExitTarget = typeof JevExitTargetSchema.Type
export type JevExitTargetMaterial = Omit<JevExitTarget, 'evidence'> & { readonly evidence: JevExitEvidenceMaterial }

const isProfitExit = (target: JevExitTargetMaterial | undefined): target is JevExitTargetMaterial =>
  target !== undefined &&
  (target.reason === JevExitReason.ProfitTarget ||
    (target.reason === JevExitReason.ProtectionReleased &&
      target.evidence.portfolio.purpose === JevPurpose.Manage &&
      target.evidence.portfolio.profitExitRequested))

export const jevProfitTargetStopCrossed = (
  target: JevExitTargetMaterial,
  observedAt: string,
  evaluatedAt: string,
  source: PriceExitSource,
) =>
  Result.gen(function* () {
    if (!isProfitExit(target)) return false
    const portfolio = target.evidence.portfolio
    if (portfolio.purpose !== JevPurpose.Manage)
      return yield* invalid('A profit limit requires the entry-bound managed portfolio')
    const plan = yield* jevManagedExitPlan(portfolio, target.symbols[0])
    const short = isShortExitPlan(plan)
    const { bid, ask, quote } = yield* verifiedPositionQuote(
      {
        protocol: target.evidence.protocol,
        sessionDate: target.sessionDate,
        observedAt,
        symbol: plan.levels.symbol,
        ...(short ? { positionSide: 'SHORT' as const } : {}),
      },
      source,
    )
    if (
      evaluatedAt < observedAt ||
      !jevProtectiveQuoteIsFresh(quote, evaluatedAt, target.evidence.protocol.maximumQuoteAgeMs)
    )
      return yield* invalid('Profit cancellation quote expired before its decision')
    return jevProtectiveStopCrossed(short ? ask : bid, plan.levels)
  })

export const jevProfitTargetLimitFloors = (
  target: JevExitTargetMaterial | undefined,
  observedAt: string,
  references: readonly { readonly symbol: string; readonly referencePriceMicros: string }[],
): Result.Result<Readonly<Record<string, bigint>>, JevContractError> =>
  Result.gen(function* () {
    if (!isProfitExit(target)) return {}
    const portfolio = target.evidence.portfolio
    if (portfolio.purpose !== JevPurpose.Manage)
      return yield* invalid('A profit limit requires the entry-bound managed portfolio')
    const plan = yield* jevManagedExitPlan(portfolio, target.symbols[0])
    if (isShortExitPlan(plan)) return {}
    const firstFill = portfolio.entryFills.find((fill) => fill.symbol === plan.levels.symbol) ?? portfolio.entryFills[0]
    const reference = references.find(({ symbol }) => symbol === plan.levels.symbol)
    if (firstFill === undefined || reference === undefined)
      return yield* invalid('A profit limit requires its first fill and current close reference')
    if (
      observedAt >= jevMaximumHoldDueAt(firstFill.occurredAt, plan.levels.maximumHoldingMinutes) ||
      jevProtectiveStopCrossed(BigInt(reference.referencePriceMicros), plan.levels)
    )
      return {}
    return { [plan.levels.symbol]: BigInt(plan.levels.profitLimitPriceMicros) }
  })

export const jevProfitTargetHoldingDeadlineAt = (
  target: JevExitTargetMaterial | undefined,
): Result.Result<string | undefined, JevContractError> => {
  if (!isProfitExit(target)) return Result.succeed(undefined)
  const portfolio = target.evidence.portfolio
  if (portfolio.purpose !== JevPurpose.Manage) return invalid('A profit limit requires the entry-bound first fill')
  const plan = jevManagedExitPlan(portfolio, target.symbols[0])
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  const firstFill =
    portfolio.entryFills.find((fill) => fill.symbol === plan.success.levels.symbol) ?? portfolio.entryFills[0]
  if (firstFill === undefined) return invalid('A profit limit requires the entry-bound first fill')
  return Result.succeed(jevMaximumHoldDueAt(firstFill.occurredAt, plan.success.levels.maximumHoldingMinutes))
}

export const jevProfitTargetLimitCeilings = (
  target: JevExitTargetMaterial | undefined,
  observedAt: string,
  references: readonly { readonly symbol: string; readonly referencePriceMicros: string }[],
): Result.Result<Readonly<Record<string, bigint>>, JevContractError> =>
  Result.gen(function* () {
    if (!isProfitExit(target)) return {}
    const portfolio = target.evidence.portfolio
    if (portfolio.purpose !== JevPurpose.Manage)
      return yield* invalid('A profit cover requires the entry-bound short portfolio')
    const plan = yield* jevManagedExitPlan(portfolio, target.symbols[0])
    if (!isShortExitPlan(plan)) return {}
    const firstFill = portfolio.entryFills.find((fill) => fill.symbol === plan.levels.symbol) ?? portfolio.entryFills[0]
    const reference = references.find((value) => value.symbol === plan.levels.symbol)
    if (firstFill === undefined || reference === undefined)
      return yield* invalid('A profit cover requires its first fill and current ask reference')
    if (
      observedAt >= jevMaximumHoldDueAt(firstFill.occurredAt, plan.levels.maximumHoldingMinutes) ||
      jevProtectiveStopCrossed(BigInt(reference.referencePriceMicros), plan.levels)
    )
      return {}
    return { [plan.levels.symbol]: BigInt(plan.levels.profitLimitPriceMicros) }
  })
