import { Data, Schema } from 'effect'

import type { ArchiveVerifiedIntradayMarketSnapshot } from '../../market-data/intraday/model'
import { intradayAgeNanos, millisecondsAsNanos } from '../../market-data/intraday/time'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SymbolSchema,
  UnitIntervalSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
  UnsignedMicrosSchema,
} from '../../schemas'
import type { IsoDate } from '../../types'
import type { StrategyDefinition, TargetPortfolio } from '../core'
import type { IntradayMomentumProtocol } from './protocol'

export type IntradayMomentumRejectionReason =
  | 'lookback-return'
  | 'breakout'
  | 'range-location'
  | 'spread'
  | 'displayed-liquidity'
  | 'market-data-freshness'

const IntradayMomentumRejectionReasonSchema = Schema.Literals([
  'lookback-return',
  'breakout',
  'range-location',
  'spread',
  'displayed-liquidity',
  'market-data-freshness',
])

const IntradayEvidenceTimestampSchema = Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema])

export const IntradayMomentumSignalSchema = Schema.Struct({
  symbol: SymbolSchema,
  referencePriceMicros: PositiveMicrosSchema,
  rangeHighPriceMicros: PositiveMicrosSchema,
  rangeLowPriceMicros: PositiveMicrosSchema,
  bidPriceMicros: PositiveMicrosSchema,
  askPriceMicros: PositiveMicrosSchema,
  bidSizeMicros: UnsignedMicrosSchema,
  askSizeMicros: UnsignedMicrosSchema,
  quoteObservedAt: IntradayEvidenceTimestampSchema,
  confirmationTradePriceMicros: PositiveMicrosSchema,
  confirmationTradeObservedAt: IntradayEvidenceTimestampSchema,
  lookbackReturnBps: Schema.Int,
  breakoutBps: Schema.Int,
  rangeLocationPpm: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  spreadBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
  eligible: Schema.Boolean,
  rejectionReasons: Schema.Array(IntradayMomentumRejectionReasonSchema).check(Schema.isUnique()),
  rank: Schema.NullOr(PositiveIntegerSchema),
})

export interface IntradayMomentumSignal {
  readonly symbol: string
  readonly referencePriceMicros: string
  readonly rangeHighPriceMicros: string
  readonly rangeLowPriceMicros: string
  readonly bidPriceMicros: string
  readonly askPriceMicros: string
  readonly bidSizeMicros: string
  readonly askSizeMicros: string
  readonly quoteObservedAt: string
  readonly confirmationTradePriceMicros: string
  readonly confirmationTradeObservedAt: string
  readonly lookbackReturnBps: number
  readonly breakoutBps: number
  readonly rangeLocationPpm: number
  readonly spreadBps: number
  readonly eligible: boolean
  readonly rejectionReasons: readonly IntradayMomentumRejectionReason[]
  readonly rank: number | null
}

type IntradayMomentumSignalEvidence = Omit<IntradayMomentumSignal, 'eligible' | 'rank' | 'rejectionReasons'>

const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const intradayMomentumSignalRejectionReasons = (
  signal: IntradayMomentumSignalEvidence,
  observedAt: string,
  protocol: IntradayMomentumProtocol,
): readonly IntradayMomentumRejectionReason[] => {
  const reasons: IntradayMomentumRejectionReason[] = []
  if (signal.lookbackReturnBps < protocol.minimumLookbackReturnBps) reasons.push('lookback-return')
  if (signal.breakoutBps < protocol.minimumBreakoutBps) reasons.push('breakout')
  if (signal.rangeLocationPpm < protocol.minimumRangeLocationPpm) reasons.push('range-location')
  if (signal.spreadBps > protocol.maximumSpreadBps) reasons.push('spread')
  if (signal.bidSizeMicros === '0' || signal.askSizeMicros === '0') reasons.push('displayed-liquidity')
  const maximumAge = millisecondsAsNanos(protocol.maximumQuoteAgeMs)
  const quoteAge = intradayAgeNanos(observedAt, signal.quoteObservedAt)
  const tradeAge = intradayAgeNanos(observedAt, signal.confirmationTradeObservedAt)
  if (quoteAge < 0n || quoteAge > maximumAge || tradeAge < 0n || tradeAge > maximumAge) {
    reasons.push('market-data-freshness')
  }
  return Object.freeze(reasons)
}

export const compareIntradayMomentumSignalStrength = (
  left: IntradayMomentumSignal,
  right: IntradayMomentumSignal,
): number =>
  right.lookbackReturnBps - left.lookbackReturnBps ||
  right.breakoutBps - left.breakoutBps ||
  right.rangeLocationPpm - left.rangeLocationPpm ||
  compareCanonicalText(left.symbol, right.symbol)

export const selectCanonicalIntradayMomentumSignals = (
  signals: readonly IntradayMomentumSignal[],
  maximumPositions: number,
): readonly IntradayMomentumSignal[] =>
  Object.freeze(
    signals
      .filter(({ eligible }) => eligible)
      .toSorted(compareIntradayMomentumSignalStrength)
      .slice(0, maximumPositions),
  )

export interface IntradayMomentumTargetPortfolio extends TargetPortfolio {
  readonly schemaVersion: 'bayn.intraday-momentum.target.v1'
  readonly strategy: 'intraday-momentum'
  readonly sessionDate: IsoDate
  readonly snapshotId: string
  readonly observedAt: string
  readonly calendarHash: string
  readonly selectedSymbols: readonly string[]
  readonly signals: readonly IntradayMomentumSignal[]
}

const IntradayMomentumTargetPortfolioBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-momentum.target.v1'),
  strategy: Schema.Literal('intraday-momentum'),
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  signals: Schema.Array(IntradayMomentumSignalSchema).check(Schema.isMinLength(1)),
})

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const targetIssues = (target: typeof IntradayMomentumTargetPortfolioBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const signalSymbols = target.signals.map(({ symbol }) => symbol)
  if (new Set(signalSymbols).size !== signalSymbols.length) {
    issues.push({ path: ['signals'], issue: 'symbols must be unique' })
  }
  if (!sameStrings(Object.keys(target.targetWeights).sort(), [...signalSymbols].sort())) {
    issues.push({ path: ['targetWeights'], issue: 'keys must exactly match signal symbols' })
  }

  const ranked = target.signals
    .filter((signal) => signal.rank !== null)
    .toSorted((left, right) => (left.rank ?? 0) - (right.rank ?? 0))
  if (
    !sameStrings(
      ranked.map(({ symbol }) => symbol),
      target.selectedSymbols,
    ) ||
    ranked.some((signal, index) => signal.rank !== index + 1 || !signal.eligible)
  ) {
    issues.push({ path: ['selectedSymbols'], issue: 'must exactly match consecutive eligible signal ranks' })
  }

  const selected = new Set(target.selectedSymbols)
  let selectedWeight: number | undefined
  for (const [index, signal] of target.signals.entries()) {
    if (signal.eligible !== (signal.rejectionReasons.length === 0)) {
      issues.push({ path: ['signals', index, 'eligible'], issue: 'must match rejection evidence' })
    }
    const weight = target.targetWeights[signal.symbol]
    if (weight === undefined) continue
    if (!selected.has(signal.symbol) && weight !== 0) {
      issues.push({ path: ['targetWeights', signal.symbol], issue: 'unselected symbols must have zero weight' })
    }
    if (selected.has(signal.symbol)) {
      if (weight <= 0) {
        issues.push({ path: ['targetWeights', signal.symbol], issue: 'selected symbols must have positive weight' })
      } else if (selectedWeight === undefined) {
        selectedWeight = weight
      } else if (weight !== selectedWeight) {
        issues.push({ path: ['targetWeights', signal.symbol], issue: 'selected symbols must use equal weights' })
      }
    }
  }
  return issues
}

export const IntradayMomentumTargetPortfolioSchema = IntradayMomentumTargetPortfolioBase.check(
  Schema.makeFilter(targetIssues),
)

export interface IntradayMomentumSessionBinding {
  readonly sessionDate: IsoDate
  readonly openAt: string
  readonly closeAt: string
  readonly calendarHash: string
}

export interface IntradayMomentumMarketContext {
  readonly snapshot: ArchiveVerifiedIntradayMarketSnapshot
  readonly session: IntradayMomentumSessionBinding
}

export type IntradayMomentumFailureReason =
  | 'snapshot-identity'
  | 'snapshot-window'
  | 'snapshot-coverage'
  | 'market-value'

export class IntradayMomentumFailure extends Data.TaggedError('IntradayMomentumFailure')<{
  readonly reason: IntradayMomentumFailureReason
  readonly message: string
  readonly symbol?: string
  readonly field?: string
  readonly observed?: unknown
  readonly cause?: unknown
}> {}

export type IntradayMomentumStrategyDefinition = StrategyDefinition<
  IntradayMomentumMarketContext,
  IntradayMomentumFailure,
  IntradayMomentumTargetPortfolio,
  IntradayMomentumProtocol
>
