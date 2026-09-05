import { Data, Schema } from 'effect'

import { MarketCalendarQueryBase, MarketCalendarResponseSchema, responseParseOptions } from '../../broker/alpaca/model'
import { PositiveMicrosSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../../schemas'
import { IntradayReplayAssumptionsSchema } from '../model'
import type { IntradayReplayEquityMark } from '../equity'
import type { EconomicReplayFill, ReplayLedger } from '../ledger'
import type { IntradayMomentumCoreOutput } from '../../strategy/intraday-momentum/decision-core'
import type { EmbeddedBuildMetadata } from '../../build'
import type { VendorHistoricalProvenance } from './alpaca/model'

const VendorReplayInputBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.vendor-intraday-replay-input.v1'),
  experimentPlanHash: Sha256Schema,
  strategyProtocolHash: Sha256Schema,
  behaviorHash: Sha256Schema,
  parameterHash: Sha256Schema,
  riskPolicyHash: Sha256Schema,
  range: MarketCalendarQueryBase,
  calendar: MarketCalendarResponseSchema.annotate({ parseOptions: responseParseOptions }),
  initialCapitalMicros: PositiveMicrosSchema,
  allocationCapitalMicros: PositiveMicrosSchema,
  scenarios: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/)),
      assumptions: IntradayReplayAssumptionsSchema,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})

export const VendorReplayInputSchema = VendorReplayInputBase.check(
  Schema.makeFilter((input) => {
    const days =
      (Date.parse(`${input.range.end}T00:00:00.000Z`) - Date.parse(`${input.range.start}T00:00:00.000Z`)) / 86_400_000 +
      1
    if (!Number.isInteger(days) || days < 1 || days > 120)
      return 'vendor replay must span 1 to 120 inclusive calendar days'
    if (BigInt(input.allocationCapitalMicros) > BigInt(input.initialCapitalMicros))
      return 'allocation must not exceed initial capital'
    if (new Set(input.scenarios.map(({ name }) => name)).size !== input.scenarios.length)
      return 'scenario names must be unique'
    return undefined
  }),
)
export type VendorReplayInput = typeof VendorReplayInputSchema.Type
export const decodeVendorReplayInput = Schema.decodeUnknownResult(VendorReplayInputSchema, strictParseOptions)

export class VendorReplayFailure extends Data.TaggedError('VendorReplayFailure')<{
  readonly operation: 'input' | 'calendar' | 'strategy' | 'market-data' | 'execution' | 'accounting' | 'report'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface VendorReplayFill extends EconomicReplayFill {
  readonly provenanceHash: string
}

export interface VendorReplayOrder {
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly submittedAt: string
  readonly arrivalAt: string
  readonly planningProvenanceHash: string
  readonly arrivalProvenanceHash: string
  readonly limitPriceMicros: string
  readonly requestedQuantityMicros: string
  readonly status: 'filled' | 'canceled'
  readonly filledQuantityMicros: string
  readonly fillPriceMicros?: string
  readonly fillNotionalMicros?: string
  readonly reason?: string
  readonly unfilledRemainder: 'none' | 'canceled'
}

export type VendorReplayObservation =
  | {
      readonly kind: 'decision'
      readonly observedAt: string
      readonly provenanceHash: string
      readonly decision: IntradayMomentumCoreOutput
    }
  | {
      readonly kind: 'quote'
      readonly purpose: 'planning' | 'arrival' | 'mark' | 'close'
      readonly observedAt: string
      readonly provenanceHash: string
      readonly equity?: IntradayReplayEquityMark
    }
  | {
      readonly kind: 'unavailable'
      readonly purpose: 'decision' | 'planning' | 'arrival' | 'mark' | 'close'
      readonly observedAt: string
      readonly reason: string
      readonly reasonCode?: string
      readonly symbol?: string
      readonly field?: string
    }

export interface VendorReplaySession {
  readonly date: string
  readonly calendarHash: string
  readonly status: 'COMPLETE' | 'INCOMPLETE'
  readonly reason: string
  readonly observations: readonly VendorReplayObservation[]
  readonly orders: readonly VendorReplayOrder[]
  readonly ledger: ReplayLedger<VendorReplayFill>
  readonly maximumObservedDrawdownMicros: string | null
  readonly peakEquityMicros: string | null
  readonly riskLimitBreached: boolean
}

export interface VendorReplayScenario {
  readonly name: string
  readonly sessions: readonly VendorReplaySession[]
  readonly totals: {
    readonly completedSessionCount: number
    readonly incompleteSessionCount: number
    readonly executionSessionCount: number
    readonly netRealizedPnlAfterCostsMicros: string | null
    readonly maximumObservedDrawdownMicros: string | null
    readonly riskLimitBreached: boolean
  }
}

export interface VendorReplayReport {
  readonly schemaVersion: 'bayn.vendor-intraday-replay-report.v1'
  readonly evidenceKind: 'COUNTERFACTUAL_RESEARCH'
  readonly qualification: 'NOT_QUALIFIED'
  readonly availability: 'event-time-only'
  readonly quoteSizePolicy: 'native-unit-share-cap.v1'
  readonly evaluatedAt: typeof UtcInstantSchema.Type
  readonly input: VendorReplayInput
  readonly inputHash: string
  readonly calendarHash: string
  readonly build: EmbeddedBuildMetadata | null
  readonly captures: readonly {
    readonly provenanceHash: string
    readonly provenance: VendorHistoricalProvenance
  }[]
  readonly scenarios: readonly VendorReplayScenario[]
  readonly limitations: readonly string[]
  readonly reportHash: string
}
