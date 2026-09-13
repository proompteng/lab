import { createHash } from 'node:crypto'
import { Result } from 'effect'
import { marketFeatureClockSkewAllowanceMs } from '../features/contract'
import { decodeTechnicalMarketFeature, type TechnicalMarketFeature } from '../features/technical-contract'
import type { KafkaMarketRecord, StreamingUniverse } from './raw-events'
import type { ObservedFeature, StreamingProjection } from './projection'

export interface TechnicalInputRejection {
  readonly availableAtMs: number
  readonly sequence: number
  readonly topic: string
  readonly partition: number
  readonly offset: string
  readonly reason: string
}

const compareObservation = (
  left: Pick<TechnicalInputRejection, 'availableAtMs' | 'sequence'>,
  right: Pick<TechnicalInputRejection, 'availableAtMs' | 'sequence'>,
) => left.availableAtMs - right.availableAtMs || left.sequence - right.sequence

export const technicalReceiptAvailableAt = (
  state: StreamingProjection,
  candidate: ObservedFeature<TechnicalMarketFeature>,
  observedAtMs: number,
) =>
  candidate.topic === state.technicalTopic &&
  candidate.availableAtMs <= observedAtMs &&
  (state.technicalRejectionsDiscardedThrough === null ||
    compareObservation(candidate, state.technicalRejectionsDiscardedThrough) > 0) &&
  !(state.technicalFeatures.get(candidate.value.material.symbol) ?? []).some(
    (newer) =>
      newer.value.material.sessionDate === candidate.value.material.sessionDate &&
      newer.value.material.windowEndMs === candidate.value.material.windowEndMs &&
      newer.sequence > candidate.sequence &&
      newer.availableAtMs <= observedAtMs,
  ) &&
  !state.technicalRejections.some(
    (rejection) => rejection.availableAtMs <= observedAtMs && rejection.sequence >= candidate.sequence,
  )

const rejectTechnical = (
  state: StreamingProjection,
  record: KafkaMarketRecord,
  availableAtMs: number,
  reason: string,
): StreamingProjection => {
  const rejections = [
    ...state.technicalRejections,
    {
      availableAtMs,
      sequence: state.sequence,
      topic: record.topic,
      partition: record.partition,
      offset: record.offset,
      reason,
    },
  ]
  const discarded = rejections.length > 256 ? rejections[rejections.length - 257] : undefined
  return {
    ...state,
    technicalFeatureArrival: null,
    technicalRejections: rejections.slice(-256),
    technicalRejectionsDiscardedThrough:
      discarded !== undefined &&
      (state.technicalRejectionsDiscardedThrough === null ||
        compareObservation(discarded, state.technicalRejectionsDiscardedThrough) > 0)
        ? { availableAtMs: discarded.availableAtMs, sequence: discarded.sequence }
        : state.technicalRejectionsDiscardedThrough,
  }
}

/** Optional derived inputs have their own rejection history; they cannot invalidate accepted baseline data. */
export const incorporateTechnicalRecord = (
  previous: StreamingProjection,
  record: KafkaMarketRecord,
  universe: StreamingUniverse,
  availableAtMs: number,
): StreamingProjection => {
  if (
    !Number.isSafeInteger(record.partition) ||
    record.partition < 0 ||
    record.partition > 2_147_483_647 ||
    !/^(0|[1-9][0-9]*)$/.test(record.offset) ||
    BigInt(record.offset) > 9_223_372_036_854_775_807n ||
    !Number.isSafeInteger(availableAtMs) ||
    availableAtMs < 0
  )
    return rejectTechnical(previous, record, availableAtMs, 'invalid-technical-transport')
  const key = `${record.topic}:${record.partition}`
  const hash = createHash('sha256').update(record.value).digest('hex')
  const priorOffset = previous.offsets.get(key)
  if (priorOffset !== undefined && BigInt(record.offset) <= BigInt(priorOffset)) {
    const retained = [...previous.technicalFeatures.values()]
      .flat()
      .find(
        (value) =>
          value.topic === record.topic && value.partition === record.partition && value.offset === record.offset,
      )
    return retained !== undefined && retained.recordHash !== hash
      ? rejectTechnical(previous, record, availableAtMs, 'conflicting-immutable-technical-record')
      : previous
  }
  const state: StreamingProjection = {
    ...previous,
    sequence: previous.sequence + 1,
    featureArrival: null,
    technicalFeatureArrival: null,
    technicalTopic: record.topic,
    offsets: new Map(previous.offsets).set(key, record.offset),
  }
  const parsed = Result.try({ try: (): unknown => JSON.parse(record.value), catch: () => 'invalid-json' }).pipe(
    Result.flatMap(decodeTechnicalMarketFeature),
  )
  if (Result.isFailure(parsed)) return rejectTechnical(state, record, availableAtMs, 'invalid-technical-feature')
  const feature = parsed.success,
    material = feature.material
  if (
    material.universeId !== universe.universeId ||
    material.universeSymbolHash !== universe.universeSymbolHash ||
    !universe.symbols.includes(material.symbol) ||
    material.inputs.some((input) => input.sourceTopic !== universe.topics.bars) ||
    feature.computedAtMs > availableAtMs + marketFeatureClockSkewAllowanceMs ||
    (record.timestampMs !== undefined &&
      (!Number.isSafeInteger(record.timestampMs) ||
        Math.abs(record.timestampMs - feature.computedAtMs) > marketFeatureClockSkewAllowanceMs))
  )
    return rejectTechnical(state, record, availableAtMs, 'technical-identity-or-availability')
  const retained = state.technicalFeatures.get(material.symbol) ?? []
  // Keep the first observed availability of a semantic value across at-least-once delivery.
  if (retained.some((entry) => entry.value.featureId === feature.featureId)) return state
  const incoming: ObservedFeature<TechnicalMarketFeature> = {
    value: feature,
    availableAtMs,
    sequence: state.sequence,
    recordHash: hash,
    topic: record.topic,
    partition: record.partition,
    offset: record.offset,
  }
  const features = [...retained, incoming]
    .toSorted(
      (left, right) =>
        right.value.material.windowEndMs - left.value.material.windowEndMs || right.sequence - left.sequence,
    )
    .slice(0, 64)
  return {
    ...state,
    technicalFeatureArrival: incoming,
    technicalFeatures: new Map(state.technicalFeatures).set(material.symbol, features),
  }
}
