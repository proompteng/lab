import { Data, Schema } from 'effect'

import {
  decodeMarketCalendarQuery,
  MarketCalendarQueryBase,
  MarketCalendarResponseSchema,
  responseParseOptions,
} from '../broker/alpaca/model'
import type { EmbeddedBuildMetadata } from '../build'
import type { IntradaySnapshotManifest } from '../market-data/intraday/model'
import { PositiveMicrosSchema, strictParseOptions } from '../schemas'
import type { IntradayMomentumTargetPortfolio } from '../strategy/intraday-momentum/model'
import type { IntradayReplayIocOutcome } from './execution'

const ReplayInputBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-replay-input.v1'),
  range: MarketCalendarQueryBase,
  calendar: MarketCalendarResponseSchema.annotate({ parseOptions: responseParseOptions }),
  initialCapitalMicros: PositiveMicrosSchema,
  allocationCapitalMicros: PositiveMicrosSchema,
  assumptions: Schema.Struct({
    pollIntervalMs: Schema.Literal(30_000),
    firstPollDelayMs: Schema.Int.check(Schema.isBetween({ minimum: 2_000, maximum: 31_999 })),
    orderLatencyMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
    availableLiquidityPpm: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
    slippageBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    feeMultiplierPpm: Schema.Int.check(Schema.isBetween({ minimum: 1_000_000, maximum: 10_000_000 })),
  }),
})

export const IntradayReplayInputSchema = ReplayInputBase.check(
  Schema.makeFilter((input) => {
    if (decodeMarketCalendarQuery(input.range)._tag === 'Failure') {
      return 'replay range must contain ordered calendar dates spanning at most 31 days'
    }
    if (BigInt(input.allocationCapitalMicros) > BigInt(input.initialCapitalMicros)) {
      return 'allocation must not exceed the modeled starting capital'
    }
    return undefined
  }),
)
export type IntradayReplayInput = typeof IntradayReplayInputSchema.Type
export const decodeIntradayReplayInput = Schema.decodeUnknownResult(IntradayReplayInputSchema, strictParseOptions)

export class IntradayReplayFailure extends Data.TaggedError('IntradayReplayFailure')<{
  readonly operation: 'input' | 'calendar' | 'strategy' | 'accounting' | 'execution' | 'query' | 'report'
  readonly message: string
  readonly cause?: unknown
}> {}

export type IntradayReplayObservation =
  | {
      readonly kind: 'snapshot'
      readonly purpose: 'decision' | 'planning' | 'arrival' | 'mark' | 'close'
      readonly manifest: IntradaySnapshotManifest
      readonly decision?: IntradayMomentumTargetPortfolio
    }
  | {
      readonly kind: 'unavailable'
      readonly observedAt: string
      readonly purpose: 'decision' | 'planning' | 'arrival' | 'mark' | 'close'
      readonly reason: string
      readonly message: string
      readonly retryable: boolean
    }

export interface IntradayReplayFill {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly observedAt: string
  readonly quantityMicros: string
  readonly priceMicros: string
  readonly notionalMicros: string
  readonly snapshotId: string
}

export interface IntradayReplayPosition {
  readonly symbol: string
  readonly quantityMicros: string
  readonly costBasisMicros: string
}

export interface IntradayReplaySession {
  readonly date: string
  readonly calendarHash: string
  readonly status: 'COMPLETE' | 'INCOMPLETE'
  readonly reason: string
  readonly observations: readonly IntradayReplayObservation[]
  readonly orders: readonly IntradayReplayIocOutcome[]
  readonly fills: readonly IntradayReplayFill[]
  readonly positions: readonly IntradayReplayPosition[]
  readonly openingCashMicros: string
  readonly cashMicros: string
  readonly executionFeesMicros: string
  readonly netRealizedPnlAfterCostsMicros: string | null
  readonly maximumObservedDrawdownMicros: string | null
}

export interface IntradayReplayReport {
  readonly schemaVersion: 'bayn.intraday-replay-report.v1'
  readonly evidenceKind: 'COUNTERFACTUAL_RESEARCH'
  readonly qualification: 'NOT_QUALIFIED'
  readonly inputHash: string
  readonly input: IntradayReplayInput
  readonly build: EmbeddedBuildMetadata | null
  readonly protocolHash: string
  readonly strategyProtocolHash: string
  readonly riskPolicyHash: string
  readonly calendarHash: string
  readonly sessions: readonly IntradayReplaySession[]
  readonly totals: {
    readonly completedSessionCount: number
    readonly incompleteSessionCount: number
    readonly executionSessionCount: number
    readonly netRealizedPnlAfterCostsMicros: string | null
  }
  readonly limitations: readonly string[]
  readonly reportHash: string
}
