import { Effect, Ref } from 'effect'

export interface Counter {
  readonly inc: (value?: number) => Effect.Effect<void, never, never>
}

export interface Histogram {
  readonly observe: (value: number) => Effect.Effect<void, never, never>
}

export interface MetricsRegistry {
  readonly counter: (name: string, description?: string) => Effect.Effect<Counter, never, never>
  readonly histogram: (name: string, description?: string) => Effect.Effect<Histogram, never, never>
}

export const makeInMemoryMetrics = (): Effect.Effect<MetricsRegistry, never, never> =>
  Effect.gen(function* () {
    const counters = yield* Ref.make(new Map<string, number>())
    const histograms = yield* Ref.make(new Map<string, number[]>())

    const counter: MetricsRegistry['counter'] = (name) =>
      Effect.sync(() => ({
        inc: (value = 1) =>
          Ref.update(counters, (map) => {
            map.set(name, (map.get(name) ?? 0) + value)
            return map
          }),
      }))

    const histogram: MetricsRegistry['histogram'] = (name) =>
      Effect.sync(() => ({
        observe: (value) =>
          Ref.update(histograms, (map) => {
            const bucket = map.get(name) ?? []
            bucket.push(value)
            map.set(name, bucket)
            return map
          }),
      }))

    // TODO(TBS-004): Export metrics via OpenTelemetry / Prometheus integrations.

    return {
      counter,
      histogram,
    }
  })
