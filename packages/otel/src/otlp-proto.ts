import type { KeyValue, OtlpAttributeValue } from './otlp'
import { type SerializedResourceSpans, serializeSpans } from './otlp-serialize'
import { AggregationTemporality, type MetricDataPoint, type ResourceMetrics } from './sdk-metrics'
import { type SpanData, SpanKind, type SpanStatus } from './sdk-trace'

const textEncoder = new TextEncoder()
const MAX_UINT64 = (1n << 64n) - 1n

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array()
  }
  let total = 0
  for (const chunk of chunks) {
    total += chunk.length
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

const toBigInt = (value: string | number | bigint | undefined): bigint => {
  if (value === undefined) {
    return 0n
  }
  if (typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      return 0n
    }
  }
  if (!Number.isFinite(value)) {
    return 0n
  }
  return BigInt(Math.trunc(value))
}

const toUnsigned = (value: bigint): bigint => (value < 0n ? MAX_UINT64 + value + 1n : value)

const hexToBytes = (hex: string): Uint8Array => {
  const normalized = hex.length % 2 === 1 ? `0${hex}` : hex
  const length = normalized.length / 2
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    const start = i * 2
    bytes[i] = Number.parseInt(normalized.slice(start, start + 2), 16)
  }
  return bytes
}

class ProtoWriter {
  readonly #chunks: Uint8Array[] = []

  writeTag(field: number, wireType: number): void {
    this.writeVarint(BigInt((field << 3) | wireType))
  }

  writeVarint(value: bigint): void {
    let remaining = value
    if (remaining < 0n) {
      remaining = toUnsigned(remaining)
    }
    while (remaining > 0x7fn) {
      this.#chunks.push(Uint8Array.of(Number((remaining & 0x7fn) | 0x80n)))
      remaining >>= 7n
    }
    this.#chunks.push(Uint8Array.of(Number(remaining)))
  }

  writeVarintField(field: number, value: number | bigint): void {
    this.writeTag(field, 0)
    this.writeVarint(typeof value === 'bigint' ? value : BigInt(value))
  }

  writeInt64Field(field: number, value: string | number | bigint): void {
    this.writeTag(field, 0)
    this.writeVarint(toBigInt(value))
  }

  writeUint64Field(field: number, value: string | number | bigint): void {
    this.writeTag(field, 0)
    this.writeVarint(toUnsigned(toBigInt(value)))
  }

  writeBytes(bytes: Uint8Array): void {
    this.writeVarint(BigInt(bytes.length))
    this.#chunks.push(bytes)
  }

  writeBytesField(field: number, bytes: Uint8Array): void {
    this.writeTag(field, 2)
    this.writeBytes(bytes)
  }

  writeStringField(field: number, value: string): void {
    this.writeTag(field, 2)
    const bytes = textEncoder.encode(value)
    this.writeBytes(bytes)
  }

  writeFixed64Field(field: number, value: string | number | bigint): void {
    this.writeTag(field, 1)
    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    let remaining = toBigInt(value)
    if (remaining < 0n) {
      remaining = toUnsigned(remaining)
    }
    for (let i = 0; i < 8; i += 1) {
      view.setUint8(i, Number(remaining & 0xffn))
      remaining >>= 8n
    }
    this.#chunks.push(new Uint8Array(buffer))
  }

  writeDoubleField(field: number, value: number): void {
    this.writeTag(field, 1)
    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    view.setFloat64(0, Number.isFinite(value) ? value : 0, true)
    this.#chunks.push(new Uint8Array(buffer))
  }

  writeMessageField(field: number, message: Uint8Array): void {
    this.writeBytesField(field, message)
  }

  finish(): Uint8Array {
    return concatChunks(this.#chunks)
  }
}

const encodeAnyValue = (value: OtlpAttributeValue): Uint8Array => {
  const writer = new ProtoWriter()
  if (value.stringValue !== undefined) {
    writer.writeStringField(1, value.stringValue)
  } else if (value.boolValue !== undefined) {
    writer.writeVarintField(2, value.boolValue ? 1 : 0)
  } else if (value.intValue !== undefined) {
    writer.writeInt64Field(3, value.intValue)
  } else if (value.doubleValue !== undefined) {
    writer.writeDoubleField(4, value.doubleValue)
  } else if (value.arrayValue?.values) {
    const arrayWriter = new ProtoWriter()
    for (const entry of value.arrayValue.values) {
      arrayWriter.writeMessageField(1, encodeAnyValue(entry))
    }
    writer.writeMessageField(5, arrayWriter.finish())
  }
  return writer.finish()
}

const encodeKeyValue = (entry: KeyValue): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeStringField(1, entry.key)
  writer.writeMessageField(2, encodeAnyValue(entry.value))
  return writer.finish()
}

const encodeInstrumentationScope = (scope: { name: string; version?: string }): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeStringField(1, scope.name)
  if (scope.version) {
    writer.writeStringField(2, scope.version)
  }
  return writer.finish()
}

const encodeResource = (attributes: KeyValue[]): Uint8Array => {
  const writer = new ProtoWriter()
  for (const entry of attributes) {
    writer.writeMessageField(1, encodeKeyValue(entry))
  }
  return writer.finish()
}

const encodeSpanEvent = (event: { name: string; timeUnixNano: string; attributes: KeyValue[] }): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeFixed64Field(1, event.timeUnixNano)
  writer.writeStringField(2, event.name)
  for (const attribute of event.attributes) {
    writer.writeMessageField(3, encodeKeyValue(attribute))
  }
  return writer.finish()
}

const encodeStatus = (status: SpanStatus): Uint8Array => {
  const writer = new ProtoWriter()
  if (status.message) {
    writer.writeStringField(2, status.message)
  }
  writer.writeVarintField(3, status.code)
  return writer.finish()
}

const encodeSpan = (span: {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: KeyValue[]
  status?: SpanStatus
  events?: Array<{ name: string; timeUnixNano: string; attributes: KeyValue[] }>
}): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeBytesField(1, hexToBytes(span.traceId))
  writer.writeBytesField(2, hexToBytes(span.spanId))
  if (span.parentSpanId) {
    writer.writeBytesField(4, hexToBytes(span.parentSpanId))
  }
  writer.writeStringField(5, span.name)
  writer.writeVarintField(6, span.kind ?? SpanKind.UNSPECIFIED)
  writer.writeFixed64Field(7, span.startTimeUnixNano)
  writer.writeFixed64Field(8, span.endTimeUnixNano)
  for (const attribute of span.attributes) {
    writer.writeMessageField(9, encodeKeyValue(attribute))
  }
  if (span.events) {
    for (const event of span.events) {
      writer.writeMessageField(11, encodeSpanEvent(event))
    }
  }
  if (span.status) {
    writer.writeMessageField(15, encodeStatus(span.status))
  }
  return writer.finish()
}

const encodeScopeSpans = (scopeSpans: SerializedResourceSpans['scopeSpans'][number]): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeMessageField(1, encodeInstrumentationScope(scopeSpans.scope))
  for (const span of scopeSpans.spans) {
    writer.writeMessageField(2, encodeSpan(span))
  }
  return writer.finish()
}

const encodeResourceSpans = (resourceSpans: SerializedResourceSpans): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeMessageField(1, encodeResource(resourceSpans.resource.attributes))
  for (const scopeSpans of resourceSpans.scopeSpans) {
    writer.writeMessageField(2, encodeScopeSpans(scopeSpans))
  }
  return writer.finish()
}

const temporalityToEnum = (temporality: AggregationTemporality): number => {
  switch (temporality) {
    case AggregationTemporality.DELTA:
      return 1
    case AggregationTemporality.CUMULATIVE:
      return 2
    default:
      return 0
  }
}

const encodeNumberDataPoint = (dataPoint: MetricDataPoint): Uint8Array => {
  const writer = new ProtoWriter()
  if (dataPoint.startTimeUnixNano) {
    writer.writeFixed64Field(2, dataPoint.startTimeUnixNano)
  }
  if (dataPoint.timeUnixNano) {
    writer.writeFixed64Field(3, dataPoint.timeUnixNano)
  }
  if (dataPoint.asDouble !== undefined) {
    writer.writeDoubleField(4, dataPoint.asDouble)
  } else if (dataPoint.count !== undefined) {
    writer.writeInt64Field(6, dataPoint.count)
  }
  for (const attribute of dataPoint.attributes) {
    writer.writeMessageField(7, encodeKeyValue(attribute))
  }
  return writer.finish()
}

const encodeHistogramDataPoint = (dataPoint: MetricDataPoint): Uint8Array => {
  const writer = new ProtoWriter()
  if (dataPoint.startTimeUnixNano) {
    writer.writeFixed64Field(2, dataPoint.startTimeUnixNano)
  }
  if (dataPoint.timeUnixNano) {
    writer.writeFixed64Field(3, dataPoint.timeUnixNano)
  }
  if (dataPoint.count !== undefined) {
    writer.writeUint64Field(4, dataPoint.count)
  }
  if (dataPoint.sum !== undefined) {
    writer.writeDoubleField(5, dataPoint.sum)
  }
  if (dataPoint.bucketCounts) {
    for (const count of dataPoint.bucketCounts) {
      writer.writeUint64Field(6, count)
    }
  }
  if (dataPoint.explicitBounds) {
    for (const bound of dataPoint.explicitBounds) {
      writer.writeDoubleField(7, bound)
    }
  }
  if (dataPoint.min !== undefined) {
    writer.writeDoubleField(10, dataPoint.min)
  }
  if (dataPoint.max !== undefined) {
    writer.writeDoubleField(11, dataPoint.max)
  }
  for (const attribute of dataPoint.attributes) {
    writer.writeMessageField(9, encodeKeyValue(attribute))
  }
  return writer.finish()
}

const encodeMetric = (metric: ResourceMetrics['scopeMetrics'][number]['metrics'][number]): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeStringField(1, metric.name)
  if (metric.description) {
    writer.writeStringField(2, metric.description)
  }
  if (metric.unit) {
    writer.writeStringField(3, metric.unit)
  }
  if (metric.sum) {
    const sumWriter = new ProtoWriter()
    for (const dataPoint of metric.sum.dataPoints) {
      sumWriter.writeMessageField(1, encodeNumberDataPoint(dataPoint))
    }
    sumWriter.writeVarintField(2, temporalityToEnum(metric.sum.aggregationTemporality))
    sumWriter.writeVarintField(3, metric.sum.isMonotonic ? 1 : 0)
    writer.writeMessageField(7, sumWriter.finish())
  }
  if (metric.histogram) {
    const histWriter = new ProtoWriter()
    for (const dataPoint of metric.histogram.dataPoints) {
      histWriter.writeMessageField(1, encodeHistogramDataPoint(dataPoint))
    }
    histWriter.writeVarintField(2, temporalityToEnum(metric.histogram.aggregationTemporality))
    writer.writeMessageField(9, histWriter.finish())
  }
  return writer.finish()
}

const encodeScopeMetrics = (scopeMetrics: ResourceMetrics['scopeMetrics'][number]): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeMessageField(1, encodeInstrumentationScope(scopeMetrics.scope))
  for (const metric of scopeMetrics.metrics) {
    writer.writeMessageField(2, encodeMetric(metric))
  }
  return writer.finish()
}

const encodeResourceMetrics = (metrics: ResourceMetrics): Uint8Array => {
  const writer = new ProtoWriter()
  writer.writeMessageField(1, encodeResource(metrics.resource.attributes))
  for (const scopeMetrics of metrics.scopeMetrics) {
    writer.writeMessageField(2, encodeScopeMetrics(scopeMetrics))
  }
  return writer.finish()
}

export const encodeTraceRequest = (spans: SpanData[]): Uint8Array => {
  const grouped = serializeSpans(spans)
  const writer = new ProtoWriter()
  for (const resourceSpans of grouped.resourceSpans) {
    writer.writeMessageField(1, encodeResourceSpans(resourceSpans))
  }
  return writer.finish()
}

export const encodeMetricsRequest = (resourceMetrics: ResourceMetrics | ResourceMetrics[]): Uint8Array => {
  const payload = Array.isArray(resourceMetrics) ? resourceMetrics : [resourceMetrics]
  const writer = new ProtoWriter()
  for (const entry of payload) {
    writer.writeMessageField(1, encodeResourceMetrics(entry))
  }
  return writer.finish()
}
