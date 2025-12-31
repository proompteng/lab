import { ExportResultCode } from './core'
import { diag } from './diag'
import { type AttributeValue, attributesToKeyValueList, stableAttributesKey, toUnixNano } from './otlp'
import { Resource } from './resources'

export type Attributes = Record<string, AttributeValue>

export interface Counter {
  add(value: number, attributes?: Attributes): void
}

export interface Histogram {
  record(value: number, attributes?: Attributes): void
}

export enum AggregationTemporality {
  UNSPECIFIED = 'AGGREGATION_TEMPORALITY_UNSPECIFIED',
  DELTA = 'AGGREGATION_TEMPORALITY_DELTA',
  CUMULATIVE = 'AGGREGATION_TEMPORALITY_CUMULATIVE',
}

export class Aggregation {
  static Default(): Aggregation {
    return new Aggregation('default')
  }

  constructor(readonly kind: string) {}
}

export enum InstrumentType {
  COUNTER = 'counter',
  HISTOGRAM = 'histogram',
}

export type MetricDataPoint = {
  attributes: ReturnType<typeof attributesToKeyValueList>
  startTimeUnixNano: string
  timeUnixNano: string
  asDouble?: number
  count?: string
  sum?: number
  min?: number
  max?: number
  bucketCounts?: string[]
  explicitBounds?: number[]
}

export type Metric = {
  name: string
  description?: string
  unit?: string
  sum?: {
    aggregationTemporality: AggregationTemporality
    isMonotonic: boolean
    dataPoints: MetricDataPoint[]
  }
  histogram?: {
    aggregationTemporality: AggregationTemporality
    dataPoints: MetricDataPoint[]
  }
}

export type ResourceMetrics = {
  resource: { attributes: ReturnType<typeof attributesToKeyValueList> }
  scopeMetrics: Array<{ scope: { name: string; version?: string }; metrics: Metric[] }>
}

export interface PushMetricExporter {
  export(metrics: ResourceMetrics, resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void
  shutdown(): Promise<void>
  forceFlush(): Promise<void>
  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality
  selectAggregation(instrumentType: InstrumentType): Aggregation
}

export interface MetricProducer {
  collect(): ResourceMetrics | null
}

export abstract class MetricReader {
  protected metricProducer?: MetricProducer

  setMetricProducer(producer: MetricProducer): void {
    this.metricProducer = producer
    this.onInitialized()
  }

  protected onInitialized(): void {}

  abstract shutdown(): Promise<void>
  abstract forceFlush(): Promise<void>
}

type PeriodicExportingMetricReaderOptions = {
  exporter: PushMetricExporter
  exportIntervalMillis?: number
  exportTimeoutMillis?: number
}

export class PeriodicExportingMetricReader extends MetricReader {
  readonly #exporter: PushMetricExporter
  readonly #exportIntervalMillis: number
  readonly #exportTimeoutMillis?: number
  #interval: ReturnType<typeof setInterval> | undefined
  #shutdown = false
  #exporting = false

  constructor(options: PeriodicExportingMetricReaderOptions) {
    super()
    this.#exporter = options.exporter
    this.#exportIntervalMillis = Math.max(options.exportIntervalMillis ?? 60000, 1000)
    this.#exportTimeoutMillis = options.exportTimeoutMillis
  }

  protected onInitialized(): void {
    if (this.#interval) {
      return
    }
    this.#interval = setInterval(() => {
      void this.exportOnce()
    }, this.#exportIntervalMillis)
  }

  async forceFlush(): Promise<void> {
    await this.exportOnce()
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true
    if (this.#interval) {
      clearInterval(this.#interval)
      this.#interval = undefined
    }
    await this.#exporter.shutdown()
  }

  private async exportOnce(): Promise<void> {
    if (this.#shutdown || this.#exporting) {
      return
    }
    if (!this.metricProducer) {
      return
    }
    const payload = this.metricProducer.collect()
    if (!payload || payload.scopeMetrics.length === 0) {
      return
    }
    if (payload.scopeMetrics.every((scope) => scope.metrics.length === 0)) {
      return
    }
    this.#exporting = true
    try {
      await this.exportWithTimeout(payload)
    } finally {
      this.#exporting = false
    }
  }

  private exportWithTimeout(payload: ResourceMetrics): Promise<void> {
    const exportPromise = new Promise<void>((resolve, reject) => {
      this.#exporter.export(payload, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          resolve()
          return
        }
        reject(result.error ?? new Error('metrics export failed'))
      })
    })

    if (!this.#exportTimeoutMillis) {
      return exportPromise.catch((error) => {
        diag.error('metrics export failed', error)
      })
    }

    const timeoutPromise = new Promise<void>((_, reject) => {
      const handle = setTimeout(() => {
        clearTimeout(handle)
        reject(new Error('metrics export timeout'))
      }, this.#exportTimeoutMillis)
    })

    return Promise.race([exportPromise, timeoutPromise]).catch((error) => {
      diag.error('metrics export failed', error)
    })
  }
}

class CounterInstrument implements Counter {
  readonly #name: string
  readonly #description?: string
  readonly #unit?: string
  readonly #startTimeUnixNano: string
  readonly #records = new Map<string, { attributes: Attributes; value: number }>()

  constructor(name: string, description?: string, unit?: string) {
    this.#name = name
    this.#description = description
    this.#unit = unit
    this.#startTimeUnixNano = toUnixNano(Date.now())
  }

  add(value: number, attributes?: Attributes): void {
    if (!Number.isFinite(value)) {
      return
    }
    const normalized = attributes ?? {}
    const key = stableAttributesKey(normalized)
    const record = this.#records.get(key)
    if (record) {
      record.value += value
      return
    }
    this.#records.set(key, { attributes: normalized, value })
  }

  collect(timeUnixNano: string): Metric {
    const dataPoints: MetricDataPoint[] = []
    for (const record of this.#records.values()) {
      dataPoints.push({
        attributes: attributesToKeyValueList(record.attributes),
        startTimeUnixNano: this.#startTimeUnixNano,
        timeUnixNano,
        asDouble: record.value,
      })
    }
    return {
      name: this.#name,
      description: this.#description,
      unit: this.#unit,
      sum: {
        aggregationTemporality: AggregationTemporality.CUMULATIVE,
        isMonotonic: true,
        dataPoints,
      },
    }
  }
}

class HistogramInstrument implements Histogram {
  readonly #name: string
  readonly #description?: string
  readonly #unit?: string
  readonly #startTimeUnixNano: string
  readonly #records = new Map<
    string,
    { attributes: Attributes; count: number; sum: number; min: number; max: number }
  >()

  constructor(name: string, description?: string, unit?: string) {
    this.#name = name
    this.#description = description
    this.#unit = unit
    this.#startTimeUnixNano = toUnixNano(Date.now())
  }

  record(value: number, attributes?: Attributes): void {
    if (!Number.isFinite(value)) {
      return
    }
    const normalized = attributes ?? {}
    const key = stableAttributesKey(normalized)
    const record = this.#records.get(key)
    if (record) {
      record.count += 1
      record.sum += value
      record.min = Math.min(record.min, value)
      record.max = Math.max(record.max, value)
      return
    }
    this.#records.set(key, {
      attributes: normalized,
      count: 1,
      sum: value,
      min: value,
      max: value,
    })
  }

  collect(timeUnixNano: string): Metric {
    const dataPoints: MetricDataPoint[] = []
    for (const record of this.#records.values()) {
      dataPoints.push({
        attributes: attributesToKeyValueList(record.attributes),
        startTimeUnixNano: this.#startTimeUnixNano,
        timeUnixNano,
        count: record.count.toString(),
        sum: record.sum,
        min: record.count > 0 ? record.min : undefined,
        max: record.count > 0 ? record.max : undefined,
        bucketCounts: [record.count.toString()],
        explicitBounds: [],
      })
    }
    return {
      name: this.#name,
      description: this.#description,
      unit: this.#unit,
      histogram: {
        aggregationTemporality: AggregationTemporality.CUMULATIVE,
        dataPoints,
      },
    }
  }
}

class Meter {
  readonly #name: string
  readonly #version?: string
  readonly #counters = new Map<string, CounterInstrument>()
  readonly #histograms = new Map<string, HistogramInstrument>()

  constructor(name: string, version?: string) {
    this.#name = name
    this.#version = version
  }

  createCounter(name: string, options?: { description?: string; unit?: string }): Counter {
    const existing = this.#counters.get(name)
    if (existing) {
      return existing
    }
    const counter = new CounterInstrument(name, options?.description, options?.unit)
    this.#counters.set(name, counter)
    return counter
  }

  createHistogram(name: string, options?: { description?: string; unit?: string }): Histogram {
    const existing = this.#histograms.get(name)
    if (existing) {
      return existing
    }
    const histogram = new HistogramInstrument(name, options?.description, options?.unit)
    this.#histograms.set(name, histogram)
    return histogram
  }

  collect(timeUnixNano: string): Metric[] {
    const metrics: Metric[] = []
    for (const counter of this.#counters.values()) {
      metrics.push(counter.collect(timeUnixNano))
    }
    for (const histogram of this.#histograms.values()) {
      metrics.push(histogram.collect(timeUnixNano))
    }
    return metrics
  }

  toScopeMetrics(timeUnixNano: string): ResourceMetrics['scopeMetrics'][number] {
    return {
      scope: {
        name: this.#name,
        ...(this.#version ? { version: this.#version } : {}),
      },
      metrics: this.collect(timeUnixNano),
    }
  }
}

export class MeterProvider implements MetricProducer {
  readonly #resource: Resource
  readonly #meters = new Map<string, Meter>()
  readonly #readers = new Set<MetricReader>()

  constructor(options: { resource?: Resource } = {}) {
    this.#resource = options.resource ?? Resource.default()
  }

  addMetricReader(reader: MetricReader): void {
    this.#readers.add(reader)
    reader.setMetricProducer(this)
  }

  getMeter(name: string, version?: string): Meter {
    const key = `${name}:${version ?? ''}`
    const existing = this.#meters.get(key)
    if (existing) {
      return existing
    }
    const meter = new Meter(name, version)
    this.#meters.set(key, meter)
    return meter
  }

  collect(): ResourceMetrics | null {
    const timeUnixNano = toUnixNano(Date.now())
    const scopeMetrics: ResourceMetrics['scopeMetrics'] = []
    for (const meter of this.#meters.values()) {
      const entry = meter.toScopeMetrics(timeUnixNano)
      if (entry.metrics.length > 0) {
        scopeMetrics.push(entry)
      }
    }
    if (scopeMetrics.length === 0) {
      return null
    }
    return {
      resource: {
        attributes: attributesToKeyValueList(this.#resource.attributes),
      },
      scopeMetrics,
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#readers].map((reader) => reader.shutdown()))
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.#readers].map((reader) => reader.forceFlush()))
  }
}

class NoopCounter implements Counter {
  add(): void {}
}

class NoopHistogram implements Histogram {
  record(): void {}
}

class NoopMeter {
  createCounter(): Counter {
    return new NoopCounter()
  }

  createHistogram(): Histogram {
    return new NoopHistogram()
  }
}

export class NoopMeterProvider {
  getMeter(_name?: string, _version?: string): NoopMeter {
    return new NoopMeter()
  }

  addMetricReader(): void {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
