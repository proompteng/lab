import { Result } from 'effect'
import { errorCodes, findErrorBy, protocolErrorsCodesById, TimeoutError } from '@platformatic/kafka'
import type { TechnicalMarketFeature } from '../features/technical-contract'
import type { RollingMarketFeature } from '../features/contract'
import type { KafkaPartitionPosition } from './bootstrap'
import { featureMatchesBars } from '../features/contract'
import { observedBarsAt, topicPartitionKey, type ObservedFeature, type StreamingProjection } from './projection'

/** Offset distance includes control records and is not a count of market messages. */
export const partitionLagMeasurements = (
  positions: readonly KafkaPartitionPosition[],
  ends: readonly KafkaPartitionPosition[] | undefined,
) => {
  const endByPartition = new Map(ends?.map((end) => [topicPartitionKey(end.topic, end.partition), end.offset]))
  return positions.map((position) => {
    const endOffset = endByPartition.get(topicPartitionKey(position.topic, position.partition)) ?? null
    const difference = endOffset === null ? null : BigInt(endOffset) - BigInt(position.offset)
    return {
      ...position,
      endOffset,
      lagOffsets: difference === null ? null : String(difference < 0n ? 0n : difference),
    }
  })
}

/** Only SDK-defined codes are logged; broker messages and credential-bearing exception text are omitted. */
export const safeKafkaFailureCodes = (cause: unknown): readonly string[] => {
  if (!(cause instanceof Error)) return ['UNKNOWN']
  const codes = [
    ...new Set([
      ...errorCodes.filter((code) => findErrorBy(cause, 'code', code) !== null),
      ...Object.values(protocolErrorsCodesById).filter((code) => findErrorBy(cause, 'apiId', code) !== null),
      // Kafka 2.11.0 TimeoutError carries the network code; preserve its distinct class identity too.
      ...(findErrorBy(cause, 'constructor', TimeoutError) === null ? [] : [TimeoutError.code]),
    ]),
  ]
  return codes.length === 0 ? ['UNKNOWN'] : codes
}

export const featureAvailabilityMeasurement = (
  epoch: string,
  feature: ObservedFeature<RollingMarketFeature | TechnicalMarketFeature>,
  bootstrapEndOffset?: string,
) => ({
  schemaVersion: 'bayn.feature-availability.v1',
  epoch,
  sequence: feature.sequence,
  featureId: feature.value.featureId,
  definitionHash: feature.value.material.definitionHash,
  symbol: feature.value.material.symbol,
  sessionDate: feature.value.material.sessionDate,
  topic: feature.topic,
  partition: feature.partition,
  offset: feature.offset,
  bootstrapEndOffset: bootstrapEndOffset ?? null,
  retainedAtBootstrap: bootstrapEndOffset === undefined ? null : BigInt(feature.offset) < BigInt(bootstrapEndOffset),
  windowEndMs: feature.value.material.windowEndMs,
  computedAtMs: feature.value.computedAtMs,
  availableAtMs: feature.availableAtMs,
  computationDelayMs: feature.value.computedAtMs - feature.value.material.windowEndMs,
  consumerDelayMs: feature.availableAtMs - feature.value.computedAtMs,
  windowAvailabilityDelayMs: feature.availableAtMs - feature.value.material.windowEndMs,
})

/** Coverage measurements do not apply the broker calendar or grant entry authority. */
export const projectionCoverageMeasurements = (
  projection: StreamingProjection,
  symbols: readonly string[],
  observedAtMs: number,
) => {
  const windowEndMs = Math.floor((observedAtMs - 2000) / 60_000) * 60_000
  const windowStartMs = windowEndMs - 30 * 60_000
  return {
    observedAtMs,
    windowStartMs,
    windowEndMs,
    rejectedRecordsRetained: [...projection.rejections.values()].reduce((sum, entries) => sum + entries.length, 0),
    symbols: symbols.map((symbol) => {
      const bars = observedBarsAt(
        projection,
        symbol,
        BigInt(windowStartMs) * 1_000_000n,
        BigInt(windowEndMs) * 1_000_000n,
        observedAtMs,
      ).map((entry) => entry.value)
      const features = (projection.features.get(symbol) ?? []).filter(
        (entry) =>
          entry.availableAtMs <= observedAtMs &&
          entry.value.material.windowStartMs === windowStartMs &&
          entry.value.material.windowEndMs === windowEndMs,
      )
      const matchedFeatures = features.filter((entry) => {
        const matches = featureMatchesBars(entry.value, bars)
        return Result.isSuccess(matches) && matches.success
      }).length
      const quote = projection.quotes.get(symbol)
      const trade = projection.trades.get(symbol)
      return {
        symbol,
        expectedBars: 30,
        observedBars: bars.length,
        windowFeatures: features.length,
        matchedFeatures,
        unmatchedFeatures: features.length - matchedFeatures,
        quoteAgeMs: quote === undefined ? null : observedAtMs - Date.parse(quote.value.eventAt),
        tradeAgeMs: trade === undefined ? null : observedAtMs - Date.parse(trade.value.eventAt),
      }
    }),
  }
}
