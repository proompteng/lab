import { nativeFeatureMatchesBars, rollingWindowStartMs, type NativeMarketFeature } from '../features/native-feature'
import { diagnoseStreamingInputs } from './inputs'
import { isCryptoMarketFeature } from '../features/crypto-contract'
import { Result, Schema } from 'effect'
import { errorCodes, findErrorBy, protocolErrorsCodesById, TimeoutError } from '@platformatic/kafka'
import type { TechnicalMarketFeature } from '../features/technical-contract'

import type { KafkaPartitionPosition } from './bootstrap'
import { kafkaBootstrapComplete } from './bootstrap'
import type { KafkaProjectionCut } from './kafka'
import { IntradaySnapshotPurpose } from '../intraday/model'
import { RequiredMarketFeatureSchema } from '../features/contract'
import { observedBarsAt, topicPartitionKey, type ObservedFeature, type StreamingProjection } from './projection'
import type { IntradaySnapshotFailure, IntradaySnapshotQuery } from '../intraday/model'
import { UtcInstantSchema, UtcOrderTimestampSchema } from '../../schemas'
import { intradayInstantNanos } from '../intraday/time'

const snapshotInstant = Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema])
const isRequiredFeature = Schema.is(RequiredMarketFeatureSchema)

export enum SnapshotCutReason {
  SourceUnavailable = 'SOURCE_UNAVAILABLE',
  AvailabilityNotObserved = 'AVAILABILITY_NOT_OBSERVED',
  EpochMismatch = 'EPOCH_MISMATCH',
  RequiredPartitionsMissing = 'REQUIRED_PARTITIONS_MISSING',
  BootstrapOffsetsIncomplete = 'BOOTSTRAP_OFFSETS_INCOMPLETE',
  BootstrapAfterObservation = 'BOOTSTRAP_AFTER_OBSERVATION',
}

/** Diagnose the rejected cut, never a later sample. Only bounded, query-owned coordinates leave this boundary. */
export const snapshotCutMeasurement = (cut: KafkaProjectionCut, query: IntradaySnapshotQuery) => {
  const source = cut.projection.sources.get(query.universeId)
  const topics = new Set(Object.values(source?.topics ?? {}))
  const partitions = cut.bootstrap.partitions.filter(
    (partition) =>
      topics.has(partition.topic) &&
      (query.purpose !== IntradaySnapshotPurpose.Liquidation || partition.topic === query.sourceTopics.quotes),
  )
  const requiredTopics = new Set(partitions.map((partition) => partition.topic))
  const positions = cut.positions.filter((position) => requiredTopics.has(position.topic))
  const byPartition = new Map(
    positions.map((position) => [topicPartitionKey(position.topic, position.partition), position]),
  )
  const pending = partitions.filter((partition) => {
    const position = byPartition.get(topicPartitionKey(partition.topic, partition.partition))
    return position === undefined || BigInt(position.offset) < BigInt(partition.endOffset)
  })
  const reasons: SnapshotCutReason[] = []
  if (source === undefined) reasons.push(SnapshotCutReason.SourceUnavailable)
  if (cut.projection.availabilityMode !== 'observed') reasons.push(SnapshotCutReason.AvailabilityNotObserved)
  if (cut.bootstrap.epoch !== cut.projection.epoch) reasons.push(SnapshotCutReason.EpochMismatch)
  if (partitions.length === 0) reasons.push(SnapshotCutReason.RequiredPartitionsMissing)
  if (partitions.length > 0 && !kafkaBootstrapComplete({ ...cut.bootstrap, partitions }, positions))
    reasons.push(SnapshotCutReason.BootstrapOffsetsIncomplete)
  if (cut.bootstrap.observedAtMs > Date.parse(query.observedAt))
    reasons.push(SnapshotCutReason.BootstrapAfterObservation)
  return {
    schemaVersion: 'bayn.snapshot-cut-diagnostic.v1',
    reasons,
    requiredPartitionCount: partitions.length,
    observedPositionCount: byPartition.size,
    pendingPartitionCount: pending.length,
    pendingPartitionsTruncated: pending.length > 8,
    pendingPartitions: pending.slice(0, 8).map((partition) => ({
      topic: Object.values(query.sourceTopics).includes(partition.topic) ? partition.topic : null,
      partition: partition.partition,
      position: byPartition.get(topicPartitionKey(partition.topic, partition.partition))?.offset ?? null,
      requiredEndOffset: partition.endOffset,
    })),
  }
}

/** Only query-bound identities, timestamps and finite publication durations leave the failure boundary. */
export const snapshotFailureMeasurement = (
  failure: IntradaySnapshotFailure,
  query: IntradaySnapshotQuery,
  projection: StreamingProjection,
) => {
  const facts = failure.facts
  const symbol = facts?.['symbol']
  const sourceTopic = facts?.['sourceTopic']
  const eventAt = facts?.['eventAt']
  const ingestedAt = facts?.['ingestedAt']
  const requiredFeature = facts?.['requiredFeature']
  const feature =
    typeof symbol === 'string' &&
    query.universe.includes(symbol) &&
    isRequiredFeature(requiredFeature) &&
    requiredFeature.windowStartAt === query.rangeStartAt &&
    requiredFeature.windowEndAt === query.rangeEndAt
      ? {
          definitionId: requiredFeature.definitionId,
          definitionHash: requiredFeature.definitionHash,
          windowStartAt: requiredFeature.windowStartAt,
          windowEndAt: requiredFeature.windowEndAt,
        }
      : undefined
  const windowStartMs = Date.parse(query.rangeStartAt)
  const windowEndMs = Date.parse(query.rangeEndAt)
  const expectedBars = (windowEndMs - windowStartMs) / 60_000
  let coverage: { expectedBars: number; observedBars: number; missingBarEventAts: readonly string[] } | undefined
  if (
    feature !== undefined &&
    typeof symbol === 'string' &&
    Number.isInteger(expectedBars) &&
    expectedBars > 0 &&
    expectedBars <= 30 &&
    windowStartMs % 60_000 === 0 &&
    windowEndMs % 60_000 === 0
  ) {
    const start = BigInt(windowStartMs) * 1_000_000n
    const end = BigInt(windowEndMs) * 1_000_000n
    const present = new Set(
      observedBarsAt(projection, symbol, start, end, Date.parse(query.observedAt)).map((entry) =>
        intradayInstantNanos(entry.value.eventAt),
      ),
    )
    const missingBarEventAts: string[] = []
    for (let at = start; at < end; at += 60_000_000_000n)
      if (!present.has(at)) missingBarEventAts.push(new Date(Number(at / 1_000_000n)).toISOString())
    coverage = { expectedBars, observedBars: expectedBars - missingBarEventAts.length, missingBarEventAts }
  }
  const durations: {
    publicationDelayMs?: number
    minimumPublicationDelayMs?: number
    maximumPublicationDelayMs?: number
  } = {}
  for (const key of ['publicationDelayMs', 'minimumPublicationDelayMs', 'maximumPublicationDelayMs'] as const) {
    const value = facts?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) durations[key] = value
  }
  const diagnosed = diagnoseStreamingInputs(projection, query)
  const candidateCoverage = Result.isSuccess(diagnosed)
    ? diagnosed.success.candidates.map(({ matchingFeature, ...candidate }) => ({
        ...candidate,
        matchingFeature:
          matchingFeature === null
            ? null
            : { featureId: matchingFeature.value.featureId, availableAtMs: matchingFeature.availableAtMs },
      }))
    : null
  return {
    schemaVersion: 'bayn.market-snapshot-failure.v2',
    purpose: query.purpose ?? 'DECISION',
    ...(query.purpose === undefined
      ? {}
      : {
          pricingQuoteCut: (query.symbols ?? query.universe).map((symbol) => {
            const quote = projection.quoteHistory
              .get(symbol)
              ?.findLast((entry) => entry.availableAtMs <= Date.parse(query.observedAt))
            return {
              symbol,
              eventAt: quote?.value.eventAt ?? null,
              availableAtMs: quote?.availableAtMs ?? null,
              ageMs: quote === undefined ? null : Date.parse(query.observedAt) - Date.parse(quote.value.eventAt),
              postRange:
                quote !== undefined && intradayInstantNanos(quote.value.eventAt) >= BigInt(windowEndMs) * 1_000_000n,
            }
          }),
        }),
    candidateCoverage,
    inputFailure: Result.isFailure(diagnosed) ? diagnosed.failure.reason : null,
    projectionCoverage: projectionCoverageMeasurements(
      projection,
      query.symbols ?? query.universe,
      Date.parse(query.observedAt),
    ),
    failureReason: failure.reason,
    ...(failure.ingestionDelayDirection === undefined
      ? {}
      : { ingestionDelayDirection: failure.ingestionDelayDirection }),
    observedAt: query.observedAt,
    rangeStartAt: query.rangeStartAt,
    rangeEndAt: query.rangeEndAt,
    ...(typeof symbol === 'string' && query.universe.includes(symbol) ? { symbol } : {}),
    ...(typeof sourceTopic === 'string' && Object.values(query.sourceTopics).includes(sourceTopic)
      ? { sourceTopic }
      : {}),
    ...(Schema.is(snapshotInstant)(eventAt) ? { eventAt } : {}),
    ...(Schema.is(snapshotInstant)(ingestedAt) ? { ingestedAt } : {}),
    ...(feature === undefined ? {} : { requiredFeature: feature, sourceTopic: query.sourceTopics.bars }),
    ...(coverage === undefined ? {} : { barCoverage: coverage }),
    ...durations,
  }
}

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
  feature: ObservedFeature<NativeMarketFeature | TechnicalMarketFeature>,
  bootstrapEndOffset?: string,
) => ({
  schemaVersion: 'bayn.feature-availability.v1',
  epoch,
  sequence: feature.sequence,
  featureId: feature.value.featureId,
  definitionHash: feature.value.material.definitionHash,
  symbol: feature.value.material.symbol,
  sessionDate: isCryptoMarketFeature(feature.value) ? null : feature.value.material.sessionDate,
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
          rollingWindowStartMs(entry.value) === windowStartMs &&
          entry.value.material.windowEndMs === windowEndMs,
      )
      const matchedFeatures = features.filter((entry) => {
        const matches = nativeFeatureMatchesBars(entry.value, bars)
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
