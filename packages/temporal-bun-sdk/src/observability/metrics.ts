import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type Meter,
  type Counter as OTelCounter,
  type Histogram as OTelHistogram,
  metrics as otelMetrics,
} from '@opentelemetry/api'
import { Effect } from 'effect'

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

export type MetricsExporterType = 'in-memory' | 'file' | 'otlp' | 'prometheus'

export interface MetricsExporterSpec {
  readonly type: MetricsExporterType
  readonly endpoint?: string
}

export const defaultMetricsExporterSpec: MetricsExporterSpec = { type: 'in-memory' }

export const cloneMetricsExporterSpec = (spec: MetricsExporterSpec): MetricsExporterSpec => ({
  type: spec.type,
  endpoint: spec.endpoint,
})

export interface MetricsExporter {
  readonly recordCounter: (name: string, value: number, description?: string) => Effect.Effect<void, never, never>
  readonly recordHistogram: (name: string, value: number, description?: string) => Effect.Effect<void, never, never>
  readonly flush: () => Effect.Effect<void, never, never>
}

const ensureDirectory = async (path: string): Promise<void> => {
  try {
    await mkdir(dirname(path), { recursive: true })
  } catch {
    // ignore errors when the directory already exists
  }
}

const toUnixNanoString = (milliseconds: number): string => (BigInt(milliseconds) * 1_000_000n).toString()

const coerceBoolean = (value: string | undefined): boolean | undefined => {
  if (!value) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) {
    return false
  }
  return undefined
}

const parseKeyValuePairs = (value?: string): Record<string, string> => {
  if (!value) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const [rawKey, ...rawRest] = pair.split('=')
    if (!rawKey || rawRest.length === 0) {
      continue
    }
    const key = rawKey.trim()
    const rawValue = rawRest.join('=').trim()
    if (!key || !rawValue) {
      continue
    }
    result[key] = rawValue
  }
  return result
}

const mergeKeyValuePairs = (...entries: Array<Record<string, string> | undefined>): Record<string, string> => {
  const merged: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry) {
      continue
    }
    Object.assign(merged, entry)
  }
  return merged
}

const resolveOtelMetricHeaders = (): Record<string, string> | undefined => {
  const shared = parseKeyValuePairs(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const metrics = parseKeyValuePairs(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS)
  const merged = mergeKeyValuePairs(shared, metrics)
  return Object.keys(merged).length > 0 ? merged : undefined
}

const resolveOtelResourceAttributes = (): Array<{ key: string; value: { stringValue: string } }> => {
  const attributes = parseKeyValuePairs(process.env.OTEL_RESOURCE_ATTRIBUTES)
  const serviceName = process.env.OTEL_SERVICE_NAME ?? process.env.LGTM_SERVICE_NAME ?? 'temporal-bun-sdk'
  if (!attributes['service.name']) {
    attributes['service.name'] = serviceName
  }
  const serviceNamespace = process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE
  if (serviceNamespace && !attributes['service.namespace']) {
    attributes['service.namespace'] = serviceNamespace
  }
  const serviceInstanceId = process.env.OTEL_SERVICE_INSTANCE_ID ?? process.env.POD_NAME ?? process.pid.toString()
  if (serviceInstanceId && !attributes['service.instance.id']) {
    attributes['service.instance.id'] = serviceInstanceId
  }
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  }))
}

const resolveOtelMetricsBridgeEnabled = (): boolean => {
  const explicit = coerceBoolean(process.env.TEMPORAL_OTEL_METRICS_BRIDGE)
  if (explicit !== undefined) {
    return explicit
  }
  const enabled = coerceBoolean(process.env.TEMPORAL_OTEL_ENABLED)
  if (enabled !== undefined) {
    return enabled
  }
  return false
}

const otelBridgeEnabled = resolveOtelMetricsBridgeEnabled()
const otelCounters = new Map<string, OTelCounter>()
const otelHistograms = new Map<string, OTelHistogram>()

const getOtelCounter = (name: string, description?: string): OTelCounter | undefined => {
  if (!otelBridgeEnabled) {
    return undefined
  }
  const existing = otelCounters.get(name)
  if (existing) {
    return existing
  }
  const meter: Meter = otelMetrics.getMeter('temporal-bun-sdk')
  const counter = meter.createCounter(name, description ? { description } : undefined)
  otelCounters.set(name, counter)
  return counter
}

const getOtelHistogram = (name: string, description?: string): OTelHistogram | undefined => {
  if (!otelBridgeEnabled) {
    return undefined
  }
  const existing = otelHistograms.get(name)
  if (existing) {
    return existing
  }
  const meter: Meter = otelMetrics.getMeter('temporal-bun-sdk')
  const histogram = meter.createHistogram(name, description ? { description } : undefined)
  otelHistograms.set(name, histogram)
  return histogram
}

const describeMetricsError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

const swallowMetricsFailure = <E, R>(
  effect: Effect.Effect<void, E, R>,
  operation: string,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn(`[temporal-bun-sdk] metrics ${operation} failed: ${describeMetricsError(error)}`)
      }),
    ),
  )

class InMemoryMetricsExporter implements MetricsExporter {
  readonly #counters = new Map<string, number>()
  readonly #histograms = new Map<string, number[]>()

  recordCounter(name: string, value: number): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const previous = this.#counters.get(name) ?? 0
      this.#counters.set(name, previous + value)
    })
  }

  recordHistogram(name: string, value: number): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const bucket = this.#histograms.get(name) ?? []
      bucket.push(value)
      this.#histograms.set(name, bucket)
    })
  }

  flush(): Effect.Effect<void, never, never> {
    return Effect.void
  }
}

class FileMetricsExporter implements MetricsExporter {
  readonly #file: string

  constructor(file: string) {
    this.#file = file
  }

  recordCounter(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'counter',
      name,
      value,
      description,
    })
    return swallowMetricsFailure(
      Effect.tryPromise(async () => {
        await ensureDirectory(this.#file)
        await appendFile(this.#file, `${entry}\n`, 'utf8')
      }),
      `append counter '${name}' to ${this.#file}`,
    )
  }

  recordHistogram(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'histogram',
      name,
      value,
      description,
    })
    return swallowMetricsFailure(
      Effect.tryPromise(async () => {
        await ensureDirectory(this.#file)
        await appendFile(this.#file, `${entry}\n`, 'utf8')
      }),
      `append histogram '${name}' to ${this.#file}`,
    )
  }

  flush(): Effect.Effect<void, never, never> {
    return Effect.void
  }
}

class OtlpMetricsExporter implements MetricsExporter {
  readonly #endpoint: string
  readonly #headers: Record<string, string> | undefined
  readonly #resourceAttributes: Array<{ key: string; value: { stringValue: string } }>
  readonly #counters = new Map<string, { value: number; description?: string }>()
  readonly #histograms = new Map<
    string,
    { count: number; sum: number; min: number; max: number; description?: string }
  >()
  readonly #startTimeUnixNano: string

  constructor(endpoint: string) {
    this.#endpoint = endpoint
    this.#startTimeUnixNano = toUnixNanoString(Date.now())
    this.#headers = resolveOtelMetricHeaders()
    this.#resourceAttributes = resolveOtelResourceAttributes()
  }

  recordCounter(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const current = this.#counters.get(name) ?? { value: 0, description }
      const next = { value: current.value + value, description: current.description ?? description }
      this.#counters.set(name, next)
    })
  }

  recordHistogram(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const current = this.#histograms.get(name)
      if (current) {
        current.count += 1
        current.sum += value
        current.min = Math.min(current.min, value)
        current.max = Math.max(current.max, value)
        if (!current.description && description) {
          current.description = description
        }
      } else {
        this.#histograms.set(name, {
          count: 1,
          sum: value,
          min: value,
          max: value,
          description,
        })
      }
    })
  }

  flush(): Effect.Effect<void, never, never> {
    return swallowMetricsFailure(
      Effect.tryPromise(async () => {
        if (this.#counters.size === 0 && this.#histograms.size === 0) {
          return
        }
        const payload = this.#buildPayload()
        const fetchFn = globalThis.fetch
        if (typeof fetchFn !== 'function') {
          throw new Error('fetch is not available in this runtime')
        }
        const response = await fetchFn(this.#endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.#headers ?? {}),
          },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          const text = await response.text()
          throw new Error(`OTLP metric push failed: ${response.status} ${response.statusText} - ${text}`)
        }
      }),
      `push OTLP metrics to ${this.#endpoint}`,
    )
  }

  #buildPayload(): Record<string, unknown> {
    const timeUnixNano = toUnixNanoString(Date.now())
    const metrics: Record<string, unknown>[] = []

    for (const [name, counter] of this.#counters) {
      metrics.push({
        name,
        description: counter.description,
        sum: {
          aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
          isMonotonic: true,
          dataPoints: [
            {
              attributes: [],
              startTimeUnixNano: this.#startTimeUnixNano,
              timeUnixNano,
              asDouble: counter.value,
            },
          ],
        },
      })
    }

    for (const [name, histogram] of this.#histograms) {
      metrics.push({
        name,
        description: histogram.description,
        histogram: {
          aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
          dataPoints: [
            {
              attributes: [],
              startTimeUnixNano: this.#startTimeUnixNano,
              timeUnixNano,
              count: `${histogram.count}`,
              sum: histogram.sum,
              min: histogram.count > 0 ? histogram.min : undefined,
              max: histogram.count > 0 ? histogram.max : undefined,
              bucketCounts: [`${histogram.count}`],
              explicitBounds: [],
            },
          ],
        },
      })
    }

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: this.#resourceAttributes,
          },
          scopeMetrics: [
            {
              scope: {
                name: 'temporal-bun-sdk',
              },
              metrics,
            },
          ],
        },
      ],
    }
  }
}

class PrometheusMetricsExporter implements MetricsExporter {
  readonly #file: string
  readonly #counters = new Map<string, { value: number; description?: string }>()
  readonly #histograms = new Map<
    string,
    { count: number; sum: number; min: number; max: number; description?: string }
  >()

  constructor(file: string) {
    this.#file = file
  }

  recordCounter(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const current = this.#counters.get(name) ?? { value: 0, description }
      const next = { value: current.value + value, description: current.description ?? description }
      this.#counters.set(name, next)
    })
  }

  recordHistogram(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const current = this.#histograms.get(name)
      if (current) {
        current.count += 1
        current.sum += value
        current.min = Math.min(current.min, value)
        current.max = Math.max(current.max, value)
        if (!current.description && description) {
          current.description = description
        }
      } else {
        this.#histograms.set(name, {
          count: 1,
          sum: value,
          min: value,
          max: value,
          description,
        })
      }
    })
  }

  flush(): Effect.Effect<void, never, never> {
    return swallowMetricsFailure(
      Effect.tryPromise(async () => {
        await ensureDirectory(this.#file)
        const lines: string[] = []
        for (const [name, counter] of this.#counters) {
          lines.push(`# HELP ${name} ${counter.description ?? 'counter metric'}`)
          lines.push(`# TYPE ${name} counter`)
          lines.push(`${name} ${counter.value}`)
        }
        for (const [name, bucket] of this.#histograms) {
          const count = bucket.count
          const sum = bucket.sum
          const min = count > 0 ? bucket.min : 0
          const max = count > 0 ? bucket.max : 0
          lines.push(`# HELP ${name} ${bucket.description ?? 'histogram metric'}`)
          lines.push(`# TYPE ${name} histogram`)
          lines.push(`${name}_count ${count}`)
          lines.push(`${name}_sum ${sum}`)
          lines.push(`${name}_min ${Number.isFinite(min) ? min : 0}`)
          lines.push(`${name}_max ${Number.isFinite(max) ? max : 0}`)
        }
        const payload = lines.join('\n')
        await writeFile(this.#file, payload, 'utf8')
      }),
      `write Prometheus metrics to ${this.#file}`,
    )
  }
}

const buildMetricsRegistry = (exporter: MetricsExporter): MetricsRegistry => ({
  counter: (name: string, description?: string) =>
    Effect.sync(() => ({
      inc: (value = 1) =>
        Effect.sync(() => {
          const counter = getOtelCounter(name, description)
          if (counter) {
            counter.add(value)
          }
        }).pipe(Effect.zipRight(exporter.recordCounter(name, value, description))),
    })),
  histogram: (name: string, description?: string) =>
    Effect.sync(() => ({
      observe: (value) =>
        Effect.sync(() => {
          const histogram = getOtelHistogram(name, description)
          if (histogram) {
            histogram.record(value)
          }
        }).pipe(Effect.zipRight(exporter.recordHistogram(name, value, description))),
    })),
})

export const createMetricsExporter = (spec: MetricsExporterSpec): Effect.Effect<MetricsExporter, never, never> =>
  Effect.gen(function* () {
    switch (spec.type) {
      case 'in-memory':
        return new InMemoryMetricsExporter()
      case 'file':
        if (!spec.endpoint) {
          throw new Error('File metrics exporter requires an endpoint (file path)')
        }
        {
          const fileEndpoint = spec.endpoint
          yield* swallowMetricsFailure(
            Effect.tryPromise(() => ensureDirectory(fileEndpoint)),
            `prepare file metrics output ${fileEndpoint}`,
          )
          return new FileMetricsExporter(fileEndpoint)
        }
      case 'prometheus':
        if (!spec.endpoint) {
          throw new Error('Prometheus exporter requires a target endpoint to write to')
        }
        {
          const prometheusEndpoint = spec.endpoint
          yield* swallowMetricsFailure(
            Effect.tryPromise(() => ensureDirectory(prometheusEndpoint)),
            `prepare Prometheus metrics output ${prometheusEndpoint}`,
          )
          return new PrometheusMetricsExporter(prometheusEndpoint)
        }
      case 'otlp':
        if (!spec.endpoint) {
          throw new Error('OTLP exporter requires an endpoint URL')
        }
        return new OtlpMetricsExporter(spec.endpoint)
      default:
        return new InMemoryMetricsExporter()
    }
  })

export const createMetricsRegistry = (exporter: MetricsExporter): MetricsRegistry => buildMetricsRegistry(exporter)

export const makeInMemoryMetrics = (): Effect.Effect<MetricsRegistry, never, never> =>
  Effect.sync(() => buildMetricsRegistry(new InMemoryMetricsExporter()))

const splitScheme = (value: string | undefined): { scheme?: string; target?: string } => {
  if (!value) {
    return {}
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return {}
  }
  const colon = trimmed.indexOf(':')
  if (colon === -1) {
    return { scheme: trimmed }
  }
  return {
    scheme: trimmed.slice(0, colon),
    target: trimmed.slice(colon + 1),
  }
}

export const resolveMetricsExporterSpec = (exporter?: string, endpoint?: string): MetricsExporterSpec => {
  const { scheme, target } = splitScheme(exporter)
  const resolvedEndpoint = target && target.length > 0 ? target : endpoint
  const normalizedScheme = scheme?.trim().toLowerCase()

  switch (normalizedScheme) {
    case 'file':
      if (!resolvedEndpoint) {
        throw new Error('File metrics exporter requires TEMPORAL_METRICS_ENDPOINT to specify a path')
      }
      return { type: 'file', endpoint: resolvedEndpoint }
    case 'prometheus':
      if (!resolvedEndpoint) {
        throw new Error('Prometheus exporter requires TEMPORAL_METRICS_ENDPOINT to specify a path')
      }
      return { type: 'prometheus', endpoint: resolvedEndpoint }
    case 'otlp':
      if (!resolvedEndpoint) {
        throw new Error('OTLP exporter requires TEMPORAL_METRICS_ENDPOINT to specify a URL')
      }
      return { type: 'otlp', endpoint: resolvedEndpoint }
    case 'in-memory':
    case 'inmemory':
    case 'memory':
    case undefined:
      return cloneMetricsExporterSpec(defaultMetricsExporterSpec)
    default:
      throw new Error(
        `Unknown metrics exporter '${normalizedScheme ?? exporter ?? ''}'; supported values are file, prometheus, otlp, in-memory`,
      )
  }
}
