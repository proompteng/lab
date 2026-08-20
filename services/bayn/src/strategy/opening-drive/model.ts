import { Data, Schema } from 'effect'

import type { IntradayMarketSnapshot } from '../../market-data'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SymbolSchema,
  UnitIntervalSchema,
  UtcInstantSchema,
  UnsignedMicrosSchema,
} from '../../schemas'
import type { IsoDate } from '../../types'
import type { StrategyDefinition, TargetPortfolio } from '../core'
import type { OpeningDriveProtocol } from './protocol'

export type OpeningDriveRejectionReason =
  | 'opening-return'
  | 'breakout'
  | 'range-location'
  | 'spread'
  | 'dollar-volume'
  | 'displayed-liquidity'

const OpeningDriveRejectionReasonSchema = Schema.Literals([
  'opening-return',
  'breakout',
  'range-location',
  'spread',
  'dollar-volume',
  'displayed-liquidity',
])

export const OpeningDriveSignalSchema = Schema.Struct({
  symbol: SymbolSchema,
  openingPriceMicros: PositiveMicrosSchema,
  rangeHighPriceMicros: PositiveMicrosSchema,
  rangeLowPriceMicros: PositiveMicrosSchema,
  bidPriceMicros: PositiveMicrosSchema,
  askPriceMicros: PositiveMicrosSchema,
  quoteObservedAt: UtcInstantSchema,
  breakoutTradePriceMicros: PositiveMicrosSchema,
  breakoutTradeObservedAt: UtcInstantSchema,
  openingReturnBps: Schema.Int,
  breakoutBps: Schema.Int,
  rangeLocationPpm: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  spreadBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
  openingDollarVolumeMicros: UnsignedMicrosSchema,
  eligible: Schema.Boolean,
  rejectionReasons: Schema.Array(OpeningDriveRejectionReasonSchema).check(Schema.isUnique()),
  rank: Schema.NullOr(PositiveIntegerSchema),
})

export interface OpeningDriveSignal {
  readonly symbol: string
  readonly openingPriceMicros: string
  readonly rangeHighPriceMicros: string
  readonly rangeLowPriceMicros: string
  readonly bidPriceMicros: string
  readonly askPriceMicros: string
  readonly quoteObservedAt: string
  readonly breakoutTradePriceMicros: string
  readonly breakoutTradeObservedAt: string
  readonly openingReturnBps: number
  readonly breakoutBps: number
  readonly rangeLocationPpm: number
  readonly spreadBps: number
  readonly openingDollarVolumeMicros: string
  readonly eligible: boolean
  readonly rejectionReasons: readonly OpeningDriveRejectionReason[]
  readonly rank: number | null
}

export interface OpeningDriveTargetPortfolio extends TargetPortfolio {
  readonly schemaVersion: 'bayn.opening-drive.target.v1'
  readonly strategy: 'opening-drive-momentum'
  readonly sessionDate: IsoDate
  readonly snapshotId: string
  readonly observedAt: string
  readonly calendarHash: string
  readonly selectedSymbols: readonly string[]
  readonly signals: readonly OpeningDriveSignal[]
}

const OpeningDriveTargetPortfolioBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opening-drive.target.v1'),
  strategy: Schema.Literal('opening-drive-momentum'),
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  signals: Schema.Array(OpeningDriveSignalSchema).check(Schema.isMinLength(1)),
})

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const openingDriveTargetIssues = (
  target: typeof OpeningDriveTargetPortfolioBase.Type,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const signalSymbols = target.signals.map(({ symbol }) => symbol)
  const targetSymbols = Object.keys(target.targetWeights).sort()
  if (new Set(signalSymbols).size !== signalSymbols.length) {
    issues.push({ path: ['signals'], issue: 'symbols must be unique' })
  }
  if (!sameStrings(targetSymbols, [...signalSymbols].sort())) {
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

export const OpeningDriveTargetPortfolioSchema = OpeningDriveTargetPortfolioBase.check(
  Schema.makeFilter(openingDriveTargetIssues),
)

/** Minimal, caller-verified exchange-calendar fact required by the pure strategy. */
export interface OpeningDriveSessionBinding {
  readonly sessionDate: IsoDate
  readonly openAt: string
  readonly closeAt: string
  readonly calendarHash: string
}

export interface OpeningDriveMarketContext {
  readonly snapshot: IntradayMarketSnapshot
  readonly session: OpeningDriveSessionBinding
}

export type OpeningDriveFailureReason = 'snapshot-identity' | 'snapshot-window' | 'snapshot-coverage' | 'market-value'

export class OpeningDriveFailure extends Data.TaggedError('OpeningDriveFailure')<{
  readonly reason: OpeningDriveFailureReason
  readonly message: string
  readonly symbol?: string
  readonly field?: string
  readonly observed?: unknown
  readonly cause?: unknown
}> {}

export type OpeningDriveStrategyDefinition = StrategyDefinition<
  OpeningDriveMarketContext,
  OpeningDriveFailure,
  OpeningDriveTargetPortfolio,
  OpeningDriveProtocol
>
