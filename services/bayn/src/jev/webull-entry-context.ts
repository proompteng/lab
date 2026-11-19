import { BigDecimal, Result, Schema } from 'effect'

import { marketFeatureClockSkewAllowanceMs } from '../market-data/features/contract'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { restoreWebullBars, webullMaximumAvailabilityLagMs } from '../market-data/streaming/webull-projection'
import { WebullSession, webullPriceFields } from '../market-data/webull-contract'
import { NonNegativeIntegerSchema, SymbolSchema, UtcInstantSchema, UtcOrderTimestampSchema } from '../schemas'
import { JevContractError } from './contract'

export const webullEntryContextPolicy = {
  schemaVersion: 'bayn.jev-webull-entry-context.v1',
  provider: 'webull',
  feed: 'nasdaq_basic',
  role: 'Supplemental completed-minute context. IEX remains the chart and execution-price source.',
  coverage: 'Provider-specific HTTP bars; consolidated SIP/NBBO coverage is not established.',
  units: 'USD per share and share volume as exact provider decimals. Do not combine this volume with IEX volume.',
} as const

export const WebullEntryContextSchema = Schema.NullOr(
  Schema.Struct({
    schemaVersion: Schema.Literal(webullEntryContextPolicy.schemaVersion),
    provider: Schema.Literal(webullEntryContextPolicy.provider),
    feed: Schema.Literal(webullEntryContextPolicy.feed),
    role: Schema.Literal(webullEntryContextPolicy.role),
    coverage: Schema.Literal(webullEntryContextPolicy.coverage),
    units: Schema.Literal(webullEntryContextPolicy.units),
    symbol: SymbolSchema,
    windowStartAt: UtcInstantSchema,
    windowEndAt: UtcInstantSchema,
    session: Schema.Enum(WebullSession),
    ...webullPriceFields,
    receivedAt: UtcOrderTimestampSchema,
    availableAt: UtcInstantSchema,
    availabilityLagMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(webullMaximumAvailabilityLagMs)),
  }),
)
export type WebullEntryContext = typeof WebullEntryContextSchema.Type

export const webullEntryContext = (snapshot: StrategyMarketSnapshot, symbol: string) =>
  Result.gen(function* () {
    const evidence = snapshot.manifest.streaming.webull
    if (evidence === undefined) return null
    const end = Date.parse(snapshot.manifest.rangeEndAt)
    const bars = yield* restoreWebullBars(evidence, end, Date.parse(snapshot.manifest.observedAt)).pipe(
      Result.mapError(
        (cause) => new JevContractError({ message: 'Webull entry context cannot reproduce its native source', cause }),
      ),
    )
    const selected = bars.find((bar) => bar.value.symbol === symbol)
    if (selected === undefined) return null
    return {
      ...webullEntryContextPolicy,
      symbol,
      windowStartAt: new Date(selected.value.startMs).toISOString(),
      windowEndAt: snapshot.manifest.rangeEndAt,
      session: selected.value.session,
      open: selected.value.open,
      high: selected.value.high,
      low: selected.value.low,
      close: selected.value.close,
      volume: selected.value.volume,
      receivedAt: selected.receivedAt,
      availableAt: new Date(selected.delivery.availableAtMs).toISOString(),
      availabilityLagMs: selected.delivery.availableAtMs - end,
    }
  })

export const verifyWebullEntryContext = (
  context: WebullEntryContext,
  symbol: string,
  windowEndAt: string,
  observedAt: string | undefined,
) => {
  if (context === null) return true
  const end = Date.parse(windowEndAt)
  const available = Date.parse(context.availableAt)
  const open = BigDecimal.fromStringUnsafe(context.open)
  const high = BigDecimal.fromStringUnsafe(context.high)
  const low = BigDecimal.fromStringUnsafe(context.low)
  const close = BigDecimal.fromStringUnsafe(context.close)
  return (
    observedAt !== undefined &&
    Math.floor(Date.parse(observedAt) / 60_000) * 60_000 === end &&
    context.symbol === symbol &&
    context.windowEndAt === windowEndAt &&
    Date.parse(context.windowStartAt) === end - 60_000 &&
    available <= Date.parse(observedAt) &&
    available - end === context.availabilityLagMs &&
    Date.parse(context.receivedAt) <= available + marketFeatureClockSkewAllowanceMs &&
    BigDecimal.isLessThanOrEqualTo(low, high) &&
    BigDecimal.isLessThanOrEqualTo(low, open) &&
    BigDecimal.isLessThanOrEqualTo(low, close) &&
    BigDecimal.isGreaterThanOrEqualTo(high, open) &&
    BigDecimal.isGreaterThanOrEqualTo(high, close)
  )
}
