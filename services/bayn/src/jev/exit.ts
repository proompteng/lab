import { exchangeSessions } from '../market-hours'
import { jevMarketForSymbol } from './markets'
import { isContinuousMarket } from '../market-hours'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { maximumBrokerObservationAgeMs } from '../broker/alpaca/observed-snapshot'
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

export enum JevExitReason {
  ProfitTarget = 'PROFIT_TARGET',
  MaximumHold = 'MAXIMUM_HOLD',
  ProtectiveStop = 'PROTECTIVE_STOP',
  ProtectionReleased = 'PROTECTION_RELEASED',
}

const TriggerSchema = Schema.Union([
  Schema.Struct({ reason: Schema.Literals([JevExitReason.MaximumHold, JevExitReason.ProtectionReleased]) }),
  Schema.Struct({
    reason: Schema.Literals([JevExitReason.ProtectiveStop, JevExitReason.ProfitTarget]),
    manifest: JevObservationSchema.fields.manifest,
    rows: JevObservationSchema.fields.rows,
  }),
])

export const JevExitEvidenceSchema = Schema.Struct({
  cycleId: Sha256Schema,
  sessionDate: IsoDateSchema,
  protocol: JevProtocolSchema,
  portfolio: JevPortfolioSchema,
  observedAt: UtcInstantSchema,
  trigger: TriggerSchema,
})
export type JevExitEvidence = typeof JevExitEvidenceSchema.Type

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
  plan: Pick<JevStrategyExitPlan, 'stopPriceMicros'>,
): boolean => bidMicros <= BigInt(plan.stopPriceMicros)
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
const equal = (left: unknown, right: unknown) => {
  const a = canonicalHashV1Result(left)
  const b = canonicalHashV1Result(right)
  return Result.isSuccess(a) && Result.isSuccess(b) && a.success === b.success
}

type PriceExitSource = {
  readonly manifest: unknown
  readonly rows: typeof JevObservationSchema.fields.rows.Type
}

const verifiedPriceExitQuote = (
  input: Pick<JevExitEvidence, 'protocol' | 'sessionDate' | 'observedAt'> & { readonly symbol: string },
  source: PriceExitSource,
) =>
  Result.gen(function* () {
    const snapshot = yield* reproduceStrategySnapshot(source.manifest, source.rows)
    const { protocol, sessionDate, observedAt, symbol } = input
    const market = jevMarketForSymbol(symbol)
    const m = snapshot.manifest
    const end = Math.floor(Date.parse(observedAt) / 60_000) * 60_000
    const session = isContinuousMarket(m.calendar)
      ? undefined
      : exchangeSessions(m.calendar).find(({ date }) => date === sessionDate)
    if (
      m.purpose !== IntradaySnapshotPurpose.Liquidation ||
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
    if (
      quote === undefined ||
      quote.bidSize <= 0 ||
      !jevProtectiveQuoteIsFresh(quote, observedAt, protocol.maximumQuoteAgeMs)
    )
      return yield* invalid('Price exit has no fresh executable bid')
    const bid = yield* priceNumberToMicros(quote.bidPrice, 'bid', 'DOWN')
    return { bid, quote }
  })

export const decideJevExit = (input: unknown) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(JevExitEvidenceSchema, strictParseOptions)(input)
    const { portfolio, protocol, trigger } = evidence
    if (portfolio.purpose !== JevPurpose.Manage) return yield* invalid('Exit requires an accounted held position')
    if (!equal(portfolio.exitPolicy, jevPositionExitPolicy(protocol, portfolio.exitPolicy.plans)))
      return yield* invalid('Exit policy differs from the policy sealed into the entry decision')
    const state = portfolio.brokerState
    const position = state.positions.find(({ quantityAtoms }) => BigInt(quantityAtoms) > 0n)
    const firstFill = portfolio.entryFills[0]
    const entryPlan = yield* jevManagedExitPlan(portfolio)
    if (position === undefined || firstFill === undefined)
      return yield* invalid('Exit requires a long position with cost basis and its first fill')
    const market = jevMarketForSymbol(position.symbol)
    const now = Date.parse(evidence.observedAt)
    if (
      !protocol.candidateSymbols.includes(position.symbol) ||
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
    let commitDeadlineAt = new Date(now + protocol.maximumQuoteAgeMs).toISOString()
    switch (trigger.reason) {
      case JevExitReason.ProtectionReleased:
        if (portfolio.exitRequestedAt === null || portfolio.exitRequestedAt > evidence.observedAt)
          return yield* invalid('Protection release requires a durable exit request or an accounted protective fill')
        break
      case JevExitReason.MaximumHold:
        if (now < Date.parse(firstFill.occurredAt) + protocol.maximumHoldingMinutes * 60_000)
          return yield* invalid('Maximum holding time has not elapsed since the actual first fill')
        break
      case JevExitReason.ProtectiveStop:
      case JevExitReason.ProfitTarget: {
        const { bid, quote } = yield* verifiedPriceExitQuote({ ...evidence, symbol: position.symbol }, trigger)
        const crossed =
          trigger.reason === JevExitReason.ProtectiveStop
            ? jevProtectiveStopCrossed(bid, entryPlan.levels)
            : yield* jevProfitTargetCrossed(portfolio, bid)
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

const isProfitExit = (target: JevExitTarget | undefined): target is JevExitTarget =>
  target !== undefined &&
  (target.reason === JevExitReason.ProfitTarget ||
    (target.reason === JevExitReason.ProtectionReleased &&
      target.evidence.portfolio.purpose === JevPurpose.Manage &&
      target.evidence.portfolio.profitExitRequested))

export const jevProfitTargetStopCrossed = (
  target: JevExitTarget,
  observedAt: string,
  evaluatedAt: string,
  source: PriceExitSource,
) =>
  Result.gen(function* () {
    if (!isProfitExit(target)) return false
    const portfolio = target.evidence.portfolio
    if (portfolio.purpose !== JevPurpose.Manage)
      return yield* invalid('A profit limit requires the entry-bound managed portfolio')
    const plan = yield* jevManagedExitPlan(portfolio)
    const { bid, quote } = yield* verifiedPriceExitQuote(
      { protocol: target.evidence.protocol, sessionDate: target.sessionDate, observedAt, symbol: plan.levels.symbol },
      source,
    )
    if (
      evaluatedAt < observedAt ||
      !jevProtectiveQuoteIsFresh(quote, evaluatedAt, target.evidence.protocol.maximumQuoteAgeMs)
    )
      return yield* invalid('Profit cancellation quote expired before its decision')
    return jevProtectiveStopCrossed(bid, plan.levels)
  })

export const jevProfitTargetLimitFloors = (
  target: JevExitTarget | undefined,
  observedAt: string,
  references: readonly { readonly symbol: string; readonly referencePriceMicros: string }[],
): Result.Result<Readonly<Record<string, bigint>>, JevContractError> =>
  Result.gen(function* () {
    if (!isProfitExit(target)) return {}
    const portfolio = target.evidence.portfolio
    if (portfolio.purpose !== JevPurpose.Manage)
      return yield* invalid('A profit limit requires the entry-bound managed portfolio')
    const plan = yield* jevManagedExitPlan(portfolio)
    const firstFill = portfolio.entryFills[0]
    const reference = references.find(({ symbol }) => symbol === plan.levels.symbol)
    if (firstFill === undefined || reference === undefined)
      return yield* invalid('A profit limit requires its first fill and current close reference')
    if (
      observedAt >= jevMaximumHoldDueAt(firstFill.occurredAt, target.evidence.protocol.maximumHoldingMinutes) ||
      jevProtectiveStopCrossed(BigInt(reference.referencePriceMicros), plan.levels)
    )
      return {}
    return { [plan.levels.symbol]: BigInt(plan.levels.profitLimitPriceMicros) }
  })

export const jevProfitTargetHoldingDeadlineAt = (
  target: JevExitTarget | undefined,
): Result.Result<string | undefined, JevContractError> => {
  if (!isProfitExit(target)) return Result.succeed(undefined)
  const portfolio = target.evidence.portfolio
  if (portfolio.purpose !== JevPurpose.Manage || portfolio.entryFills[0] === undefined)
    return invalid('A profit limit requires the entry-bound first fill')
  return Result.succeed(
    jevMaximumHoldDueAt(portfolio.entryFills[0].occurredAt, target.evidence.protocol.maximumHoldingMinutes),
  )
}
