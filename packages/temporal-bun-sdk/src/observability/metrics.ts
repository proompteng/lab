import { Effect, Ref } from 'effect'

export type MetricAttributes = Readonly<Record<string, string | number | boolean>>

export interface MetricMetadata {
  readonly description?: string
  readonly unit?: string
}

export interface HistogramMetadata extends MetricMetadata {}

export interface Counter {
  readonly inc: (value?: number, attributes?: MetricAttributes) => Effect.Effect<void, never, never>
}

export interface Histogram {
  readonly observe: (value: number, attributes?: MetricAttributes) => Effect.Effect<void, never, never>
}

export interface MetricsSnapshot {
  readonly counters: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly unit?: string
    readonly points: ReadonlyArray<{
      readonly value: number
      readonly attributes: MetricAttributes
    }>
  }>
  readonly histograms: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly unit?: string
    readonly points: ReadonlyArray<{
      readonly values: ReadonlyArray<number>
      readonly attributes: MetricAttributes
    }>
  }>
}

export interface MetricsRegistry {
  readonly counter: (name: string, metadata?: MetricMetadata) => Effect.Effect<Counter, never, never>
  readonly histogram: (name: string, metadata?: HistogramMetadata) => Effect.Effect<Histogram, never, never>
  readonly collect?: () => Effect.Effect<MetricsSnapshot, never, never>
}

const cloneMetadata = (metadata?: MetricMetadata): MetricMetadata => (metadata ? { ...metadata } : {}) as MetricMetadata

interface CounterPoint {
  value: number
  attributes: MetricAttributes
}

interface CounterState {
  metadata: MetricMetadata
  points: Map<string, CounterPoint>
}

interface HistogramPoint {
  values: number[]
  attributes: MetricAttributes
}

interface HistogramState {
  metadata: HistogramMetadata
  points: Map<string, HistogramPoint>
}

const attributesKey = (attributes: MetricAttributes): string => {
  const entries = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries)
}

const cloneAttributes = (attributes: MetricAttributes): MetricAttributes => ({ ...attributes })

const mergeMetadata = (existing: MetricMetadata, next?: MetricMetadata): MetricMetadata => ({
  description: existing.description ?? next?.description,
  unit: existing.unit ?? next?.unit,
})

const normalizeAttributes = (attributes?: MetricAttributes): MetricAttributes => {
  if (!attributes) {
    return {} as MetricAttributes
  }
  const normalized: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue
    }
    normalized[key] = value
  }
  return normalized as MetricAttributes
}

export const makeInMemoryMetrics = (): Effect.Effect<MetricsRegistry, never, never> =>
  Effect.gen(function* () {
    const counters = yield* Ref.make(new Map<string, CounterState>())
    const histograms = yield* Ref.make(new Map<string, HistogramState>())

    const registerCounter = (name: string, metadata?: MetricMetadata): Effect.Effect<CounterState, never, never> =>
      Ref.modify(counters, (map) => {
        const current = map.get(name)
        if (current) {
          current.metadata = mergeMetadata(current.metadata, metadata)
          return [current, map]
        }
        const state: CounterState = {
          metadata: cloneMetadata(metadata),
          points: new Map(),
        }
        map.set(name, state)
        return [state, map]
      })

    const registerHistogram = (
      name: string,
      metadata?: HistogramMetadata,
    ): Effect.Effect<HistogramState, never, never> =>
      Ref.modify(histograms, (map) => {
        const current = map.get(name)
        if (current) {
          current.metadata = mergeMetadata(current.metadata, metadata)
          return [current, map]
        }
        const state: HistogramState = {
          metadata: cloneMetadata(metadata),
          points: new Map(),
        }
        map.set(name, state)
        return [state, map]
      })

    const counter: MetricsRegistry['counter'] = (name, metadata) =>
      Effect.gen(function* () {
        const state = yield* registerCounter(name, metadata)
        return {
          inc: (value = 1, attributes) => {
            const normalized = normalizeAttributes(attributes)
            return Ref.update(counters, (map) => {
              const current = map.get(name) ?? state
              const key = attributesKey(normalized)
              const existing = current.points.get(key)
              if (existing) {
                existing.value += value
              } else {
                current.points.set(key, { value, attributes: normalized })
              }
              map.set(name, current)
              return map
            })
          },
        }
      })

    const histogram: MetricsRegistry['histogram'] = (name, metadata) =>
      Effect.gen(function* () {
        const state = yield* registerHistogram(name, metadata)
        return {
          observe: (value, attributes) => {
            const normalized = normalizeAttributes(attributes)
            return Ref.update(histograms, (map) => {
              const current = map.get(name) ?? state
              const key = attributesKey(normalized)
              const existing = current.points.get(key)
              if (existing) {
                existing.values.push(value)
              } else {
                current.points.set(key, { values: [value], attributes: normalized })
              }
              map.set(name, current)
              return map
            })
          },
        }
      })

    const collect = (): Effect.Effect<MetricsSnapshot, never, never> =>
      Effect.gen(function* () {
        const [counterMap, histogramMap] = yield* Effect.all([Ref.get(counters), Ref.get(histograms)])

        const countersSnapshot = Array.from(counterMap.entries()).map(([name, state]) => ({
          name,
          description: state.metadata.description,
          unit: state.metadata.unit,
          points: Array.from(state.points.values()).map((point) => ({
            value: point.value,
            attributes: cloneAttributes(point.attributes),
          })),
        }))

        const histogramsSnapshot = Array.from(histogramMap.entries()).map(([name, state]) => ({
          name,
          description: state.metadata.description,
          unit: state.metadata.unit,
          points: Array.from(state.points.values()).map((point) => ({
            values: [...point.values],
            attributes: cloneAttributes(point.attributes),
          })),
        }))

        return {
          counters: countersSnapshot,
          histograms: histogramsSnapshot,
        }
      })

    return {
      counter,
      histogram,
      collect,
    }
  })

export interface OtelMeter {
  readonly createCounter: (name: string, options?: MetricMetadata) => OtelCounter
  readonly createHistogram: (name: string, options?: HistogramMetadata) => OtelHistogram
}

export interface OtelCounter {
  readonly add: (value: number, attributes?: MetricAttributes) => void
}

export interface OtelHistogram {
  readonly record: (value: number, attributes?: MetricAttributes) => void
}

export const makeOpenTelemetryMetrics = (meter: OtelMeter): MetricsRegistry => ({
  counter(name, metadata) {
    return Effect.sync(() => {
      const counter = meter.createCounter(name, metadata)
      return {
        inc: (value = 1, attributes) =>
          Effect.sync(() => {
            counter.add(value, attributes)
          }),
      }
    })
  },
  histogram(name, metadata) {
    return Effect.sync(() => {
      const histogram = meter.createHistogram(name, metadata)
      return {
        observe: (value, attributes) =>
          Effect.sync(() => {
            histogram.record(value, attributes)
          }),
      }
    })
  },
})
