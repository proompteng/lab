import { BigDecimal, Result, Schema } from 'effect'

import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
} from '../../schemas'
import { WebullSymbolSchema } from '../webull-contract'
import { marketFeatureClockSkewAllowanceMs } from '../features/contract'
import {
  decodeWebullCapture,
  WebullCaptureKind,
  type WebullMinuteBar,
  type WebullProducerClockDiagnostic,
} from './webull-capture'
import type { KafkaMarketRecord, StreamingUniverse } from './raw-events'
import type { StreamingProjection } from './projection'

export const webullMaximumAvailabilityLagMs = 10_000
const Timestamp = NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(253402300799999))
const WebullDeliverySchema = Schema.Struct({
  record: Schema.Struct({
    topic: StrictNonEmptyStringSchema,
    partition: NonNegativeIntegerSchema,
    offset: UnsignedMicrosSchema,
    timestampMs: Timestamp,
    value: Schema.String,
  }),
  availableAtMs: Timestamp,
  sequence: PositiveIntegerSchema,
})
type WebullDelivery = typeof WebullDeliverySchema.Type
export const WebullSnapshotEvidenceSchema = Schema.Struct({
  policy: Schema.Literal('bayn.webull-completed-m1-context.v1'),
  topic: StrictNonEmptyStringSchema,
  captures: Schema.Array(WebullDeliverySchema).check(Schema.isMaxLength(64)),
  bars: Schema.Array(Schema.Struct({ symbol: WebullSymbolSchema, captureId: Schema.String.check(Schema.isUUID()) })),
  unavailableSymbols: Schema.Array(WebullSymbolSchema).check(Schema.isUnique()),
})
export type WebullSnapshotEvidence = typeof WebullSnapshotEvidenceSchema.Type
export interface ObservedWebullBar {
  readonly value: WebullMinuteBar
  readonly captureId: string
  readonly receivedAt: string
  readonly semanticId: string
  readonly delivery: WebullDelivery
}
interface WebullRejection {
  readonly reason: string
  readonly availableAtMs: number
  readonly sequence: number
  readonly symbols?: readonly string[]
  readonly producerClock?: WebullProducerClockDiagnostic
}
export interface WebullProjection {
  readonly topic?: string
  readonly bars: ReadonlyMap<string, readonly ObservedWebullBar[]>
  readonly rejections: readonly WebullRejection[]
  readonly discardedThroughSequence: number
}
export const emptyWebullProjection = (topic?: string): WebullProjection => ({
  ...(topic === undefined ? {} : { topic }),
  bars: new Map(),
  rejections: [],
  discardedThroughSequence: 0,
})

const reject = (
  state: StreamingProjection,
  availableAtMs: number,
  reason: string,
  details: Pick<WebullRejection, 'symbols' | 'producerClock'> = {},
): StreamingProjection => {
  const rejections = [...state.webull.rejections, { availableAtMs, sequence: state.sequence, reason, ...details }]
  return {
    ...state,
    webull: {
      ...state.webull,
      rejections: rejections.slice(-256),
      discardedThroughSequence: Math.max(state.webull.discardedThroughSequence, rejections.at(-257)?.sequence ?? 0),
    },
  }
}
const semanticId = (bar: WebullMinuteBar) =>
  JSON.stringify([
    bar.symbol,
    bar.startMs,
    bar.session,
    ...[bar.open, bar.high, bar.low, bar.close, bar.volume].map((value) =>
      BigDecimal.format(BigDecimal.normalize(BigDecimal.fromStringUnsafe(value))),
    ),
  ])

/** Webull cannot replace IEX pricing or invalidate the primary projection. */
export const incorporateWebullRecord = (
  previous: StreamingProjection,
  record: KafkaMarketRecord,
  universe: StreamingUniverse,
  availableAtMs: number,
): StreamingProjection => {
  if (
    !Number.isSafeInteger(availableAtMs) ||
    availableAtMs < 0 ||
    !Number.isSafeInteger(record.partition) ||
    record.partition < 0 ||
    record.partition > 2_147_483_647 ||
    !/^(0|[1-9][0-9]*)$/.test(record.offset) ||
    BigInt(record.offset) > 9_223_372_036_854_775_807n
  )
    return reject(previous, availableAtMs, 'invalid-webull-transport')
  const key = `${record.topic}:${record.partition}`
  const priorOffset = previous.offsets.get(key)
  if (priorOffset !== undefined && BigInt(record.offset) <= BigInt(priorOffset)) {
    const prior = [...previous.webull.bars.values()]
      .flat()
      .find(
        (bar) =>
          bar.delivery.record.topic === record.topic &&
          bar.delivery.record.partition === record.partition &&
          bar.delivery.record.offset === record.offset,
      )
    return prior !== undefined && prior.delivery.record.value !== record.value
      ? reject(previous, availableAtMs, 'conflicting-immutable-webull-record')
      : previous
  }
  const state = {
    ...previous,
    sequence: previous.sequence + 1,
    sources: new Map(previous.sources).set(universe.universeId, universe),
    offsets: new Map(previous.offsets).set(key, record.offset),
    featureArrival: null,
    technicalFeatureArrival: null,
    webull: { ...previous.webull, topic: record.topic },
  }
  const decoded = decodeWebullCapture(record)
  if (Result.isFailure(decoded))
    return reject(
      state,
      availableAtMs,
      decoded.failure.message,
      decoded.failure._tag === 'WebullProducerClockError' ? { producerClock: decoded.failure.producerClock } : {},
    )
  const capture = decoded.success
  if (capture.kind === WebullCaptureKind.Gap)
    return capture.gap.channel === 'bars'
      ? reject(
          state,
          availableAtMs,
          'webull-bar-gap',
          capture.gap.symbols === undefined ? {} : { symbols: capture.gap.symbols },
        )
      : state
  if (capture.kind !== WebullCaptureKind.Bars) return state
  const delivery = Schema.decodeUnknownResult(WebullDeliverySchema)({ record, availableAtMs, sequence: state.sequence })
  if (
    Result.isFailure(delivery) ||
    Date.parse(capture.receipt.receivedAt) > availableAtMs + marketFeatureClockSkewAllowanceMs
  )
    return reject(state, availableAtMs, 'invalid-webull-availability')
  const bars = new Map(state.webull.bars)
  let changed = false
  for (const value of capture.bars) {
    if (!universe.symbols.includes(value.symbol)) continue
    const retained = bars.get(value.symbol) ?? []
    const prior = retained.find((bar) => bar.value.startMs === value.startMs)
    const semantic = semanticId(value)
    // Recovery polls and repeated deliveries cannot move the first availability forward.
    if (prior !== undefined && (prior.receivedAt > capture.receipt.receivedAt || prior.semanticId === semantic))
      continue
    changed = true
    bars.set(
      value.symbol,
      [
        {
          value,
          captureId: capture.receipt.captureId,
          receivedAt: capture.receipt.receivedAt,
          semanticId: semantic,
          delivery: delivery.success,
        },
        ...retained,
      ]
        .toSorted(
          (a, b) =>
            b.value.startMs - a.value.startMs ||
            b.receivedAt.localeCompare(a.receivedAt) ||
            b.delivery.sequence - a.delivery.sequence,
        )
        .slice(0, 64),
    )
  }
  return changed ? { ...state, webull: { ...state.webull, bars } } : state
}

export const selectWebullBars = (
  state: WebullProjection,
  symbols: readonly string[],
  rangeEndMs: number,
  observedAtMs: number,
) =>
  Math.floor(observedAtMs / 60_000) * 60_000 !== rangeEndMs
    ? []
    : symbols.flatMap((symbol) => {
        const candidate = (state.bars.get(symbol) ?? []).find(
          (bar) => bar.value.startMs === rangeEndMs - 60_000 && bar.delivery.availableAtMs <= observedAtMs,
        )
        if (
          candidate === undefined ||
          candidate.delivery.availableAtMs < rangeEndMs ||
          candidate.delivery.availableAtMs - rangeEndMs > webullMaximumAvailabilityLagMs ||
          candidate.delivery.sequence <= state.discardedThroughSequence ||
          state.rejections.some(
            (rejection) =>
              rejection.availableAtMs <= observedAtMs &&
              rejection.sequence >= candidate.delivery.sequence &&
              (rejection.symbols === undefined || rejection.symbols.includes(symbol)),
          )
        )
          return []
        return [candidate]
      })

export const webullSnapshotEvidence = (
  state: WebullProjection,
  symbols: readonly string[],
  rangeEndMs: number,
  observedAtMs: number,
): WebullSnapshotEvidence | undefined => {
  if (state.topic === undefined) return undefined
  const selected = selectWebullBars(state, symbols, rangeEndMs, observedAtMs)
  return {
    policy: 'bayn.webull-completed-m1-context.v1',
    topic: state.topic,
    captures: [...new Map(selected.map((bar) => [bar.delivery.sequence, bar.delivery])).values()].toSorted(
      (a, b) => a.sequence - b.sequence,
    ),
    bars: selected.map((bar) => ({ symbol: bar.value.symbol, captureId: bar.captureId })),
    unavailableSymbols: symbols.filter((symbol) => !selected.some((bar) => bar.value.symbol === symbol)),
  }
}

/** Verify native bytes again when restoring a compacted, immutable decision cut. */
export const restoreWebullBars = (
  evidence: WebullSnapshotEvidence,
  rangeEndMs: number,
  observedAtMs: number,
): Result.Result<readonly ObservedWebullBar[], string> =>
  Result.gen(function* () {
    const captures = new Map<
      string,
      { readonly delivery: WebullDelivery; readonly bars: readonly WebullMinuteBar[]; readonly receivedAt: string }
    >()
    const sequences = new Set<number>()
    for (const delivery of evidence.captures) {
      const capture = yield* decodeWebullCapture(delivery.record).pipe(
        Result.mapError(() => 'Invalid recorded Webull native capture'),
      )
      if (
        capture.kind !== WebullCaptureKind.Bars ||
        Math.floor(observedAtMs / 60_000) * 60_000 !== rangeEndMs ||
        delivery.record.topic !== evidence.topic ||
        captures.has(capture.receipt.captureId) ||
        sequences.has(delivery.sequence) ||
        delivery.availableAtMs > observedAtMs ||
        delivery.availableAtMs < rangeEndMs ||
        delivery.availableAtMs - rangeEndMs > webullMaximumAvailabilityLagMs ||
        Date.parse(capture.receipt.receivedAt) > delivery.availableAtMs + marketFeatureClockSkewAllowanceMs
      )
        return yield* Result.fail('Invalid recorded Webull availability or capture identity')
      sequences.add(delivery.sequence)
      captures.set(capture.receipt.captureId, { delivery, bars: capture.bars, receivedAt: capture.receipt.receivedAt })
    }
    const symbols = new Set<string>()
    const used = new Set<string>()
    const bars: ObservedWebullBar[] = []
    for (const reference of evidence.bars) {
      const capture = captures.get(reference.captureId)
      const value = capture?.bars.find((bar) => bar.symbol === reference.symbol && bar.startMs === rangeEndMs - 60_000)
      if (
        capture === undefined ||
        value === undefined ||
        symbols.has(reference.symbol) ||
        evidence.unavailableSymbols.includes(reference.symbol)
      )
        return yield* Result.fail('Invalid recorded Webull bar reference')
      symbols.add(reference.symbol)
      used.add(reference.captureId)
      bars.push({
        value,
        captureId: reference.captureId,
        receivedAt: capture.receivedAt,
        semanticId: semanticId(value),
        delivery: capture.delivery,
      })
    }
    if (used.size !== captures.size) return yield* Result.fail('Unused recorded Webull capture')
    return bars
  })
