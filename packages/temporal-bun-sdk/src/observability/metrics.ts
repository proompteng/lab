import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
    return Effect.tryPromise(async () => {
      await ensureDirectory(this.#file)
      await appendFile(this.#file, `${entry}\n`, 'utf8')
    })
  }

  recordHistogram(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'histogram',
      name,
      value,
      description,
    })
    return Effect.tryPromise(async () => {
      await ensureDirectory(this.#file)
      await appendFile(this.#file, `${entry}\n`, 'utf8')
    })
  }

  flush(): Effect.Effect<void, never, never> {
    return Effect.void
  }
}

class OtlpMetricsExporter implements MetricsExporter {
  readonly #endpoint: string

  constructor(endpoint: string) {
    this.#endpoint = endpoint
  }

  #postPayload(payload: Record<string, unknown>): Effect.Effect<void, never, never> {
    return Effect.tryPromise(async () => {
      const fetchFn = globalThis.fetch
      if (typeof fetchFn !== 'function') {
        throw new Error('fetch is not available in this runtime')
      }
      const response = await fetchFn(this.#endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OTLP metric push failed: ${response.status} ${response.statusText} - ${text}`)
      }
    })
  }

  recordCounter(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    return this.#postPayload({
      type: 'counter',
      name,
      value,
      description,
      timestamp: new Date().toISOString(),
    })
  }

  recordHistogram(name: string, value: number, description?: string): Effect.Effect<void, never, never> {
    return this.#postPayload({
      type: 'histogram',
      name,
      value,
      description,
      timestamp: new Date().toISOString(),
    })
  }

  flush(): Effect.Effect<void, never, never> {
    return Effect.void
  }
}

class PrometheusMetricsExporter implements MetricsExporter {
  readonly #file: string
  readonly #counters = new Map<string, { value: number; description?: string }>()
  readonly #histograms = new Map<string, { values: number[]; description?: string }>()

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
        current.values.push(value)
      } else {
        this.#histograms.set(name, { values: [value], description })
      }
    })
  }

  flush(): Effect.Effect<void, never, never> {
    return Effect.tryPromise(async () => {
      await ensureDirectory(this.#file)
      const lines: string[] = []
      for (const [name, counter] of this.#counters) {
        lines.push(`# HELP ${name} ${counter.description ?? 'counter metric'}`)
        lines.push(`# TYPE ${name} counter`)
        lines.push(`${name} ${counter.value}`)
      }
      for (const [name, bucket] of this.#histograms) {
        const values = bucket.values
        const count = values.length
        const sum = values.reduce((acc, value) => acc + value, 0)
        const min = count > 0 ? Math.min(...values) : 0
        const max = count > 0 ? Math.max(...values) : 0
        lines.push(`# HELP ${name} ${bucket.description ?? 'histogram metric'}`)
        lines.push(`# TYPE ${name} histogram`)
        lines.push(`${name}_count ${count}`)
        lines.push(`${name}_sum ${sum}`)
        lines.push(`${name}_min ${Number.isFinite(min) ? min : 0}`)
        lines.push(`${name}_max ${Number.isFinite(max) ? max : 0}`)
      }
      const payload = lines.join('\n')
      await writeFile(this.#file, payload, 'utf8')
    })
  }
}

const buildMetricsRegistry = (exporter: MetricsExporter): MetricsRegistry => ({
  counter: (name: string, description?: string) =>
    Effect.sync(() => ({
      inc: (value = 1) => exporter.recordCounter(name, value, description),
    })),
  histogram: (name: string, description?: string) =>
    Effect.sync(() => ({
      observe: (value) => exporter.recordHistogram(name, value, description),
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
        yield* Effect.tryPromise(() => ensureDirectory(spec.endpoint))
        return new FileMetricsExporter(spec.endpoint)
      case 'prometheus':
        if (!spec.endpoint) {
          throw new Error('Prometheus exporter requires a target endpoint to write to')
        }
        yield* Effect.tryPromise(() => ensureDirectory(spec.endpoint))
        return new PrometheusMetricsExporter(spec.endpoint)
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

export const makeInMemoryMetrics = (): Effect.Effect<MetricsRegistry, never, never> => {
  const exporter = new InMemoryMetricsExporter()
  return buildMetricsRegistry(exporter)
}

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
      return defaultMetricsExporterSpec
    default:
      throw new Error(
        `Unknown metrics exporter '${normalizedScheme ?? exporter ?? ''}'; supported values are file, prometheus, otlp, in-memory`,
      )
  }
}
