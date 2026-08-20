import { Data } from 'effect'

import type { IntradayMarketSnapshot } from '../../market-data'
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
