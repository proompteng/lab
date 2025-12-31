import { ExportResultCode } from './core'
import { diag } from './diag'
import { type AttributeValue, stableAttributesKey, toUnixNano } from './otlp'
import { Resource } from './resources'

export type SpanAttributes = Record<string, AttributeValue>

export enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

export enum SpanKind {
  UNSPECIFIED = 0,
  INTERNAL = 1,
  SERVER = 2,
  CLIENT = 3,
  PRODUCER = 4,
  CONSUMER = 5,
}

export type SpanStatus = {
  code: SpanStatusCode
  message?: string
}

export type SpanEvent = {
  name: string
  timeUnixNano: string
  attributes?: SpanAttributes
}

export type SpanData = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: SpanAttributes
  status?: SpanStatus
  events?: SpanEvent[]
  resourceAttributes: SpanAttributes
  scope: { name: string; version?: string }
}

export interface SpanExporter {
  export(spans: SpanData[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void
  shutdown(): Promise<void>
}

export interface SpanProcessor {
  onStart(span: SpanData): void
  onEnd(span: SpanData): void
  shutdown(): Promise<void>
  forceFlush(): Promise<void>
}

class SimpleSpanProcessor implements SpanProcessor {
  readonly #exporter: SpanExporter

  constructor(exporter: SpanExporter) {
    this.#exporter = exporter
  }

  onStart(): void {}

  onEnd(span: SpanData): void {
    this.#exporter.export([span], (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        return
      }
      diag.error('trace export failed', result.error ?? new Error('trace export failed'))
    })
  }

  async shutdown(): Promise<void> {
    await this.#exporter.shutdown()
  }

  async forceFlush(): Promise<void> {}
}

const getRandomBytes = (size: number): Uint8Array => {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(size)
    globalThis.crypto.getRandomValues(bytes)
    return bytes
  }
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const generateTraceId = (): string => toHex(getRandomBytes(16))
const generateSpanId = (): string => toHex(getRandomBytes(8))

export type SpanOptions = {
  attributes?: SpanAttributes
  startTime?: number
  kind?: SpanKind
}

export class Span {
  readonly #traceId: string
  readonly #spanId: string
  readonly #parentSpanId?: string
  readonly #name: string
  readonly #kind: SpanKind
  readonly #startTimeUnixNano: string
  readonly #resourceAttributes: SpanAttributes
  readonly #scope: { name: string; version?: string }
  readonly #processor: SpanProcessor
  readonly #attributes: SpanAttributes
  #status?: SpanStatus
  #events: SpanEvent[] = []
  #ended = false

  constructor(options: {
    name: string
    kind: SpanKind
    attributes?: SpanAttributes
    startTimeUnixNano: string
    traceId: string
    spanId: string
    parentSpanId?: string
    resourceAttributes: SpanAttributes
    scope: { name: string; version?: string }
    processor: SpanProcessor
  }) {
    this.#name = options.name
    this.#kind = options.kind
    this.#attributes = options.attributes ?? {}
    this.#startTimeUnixNano = options.startTimeUnixNano
    this.#traceId = options.traceId
    this.#spanId = options.spanId
    this.#parentSpanId = options.parentSpanId
    this.#resourceAttributes = options.resourceAttributes
    this.#scope = options.scope
    this.#processor = options.processor

    this.#processor.onStart(this.toSpanData(this.#startTimeUnixNano))
  }

  setStatus(status: SpanStatus): void {
    this.#status = status
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.#attributes[key] = value
    return this
  }

  setAttributes(attributes: SpanAttributes): this {
    for (const [key, value] of Object.entries(attributes)) {
      this.#attributes[key] = value
    }
    return this
  }

  recordException(error: Error): void {
    const attributes: SpanAttributes = {
      'exception.type': error.name,
      'exception.message': error.message,
    }
    if (error.stack) {
      attributes['exception.stacktrace'] = error.stack
    }
    this.#events.push({
      name: 'exception',
      timeUnixNano: toUnixNano(Date.now()),
      attributes,
    })
  }

  end(endTime?: number): void {
    if (this.#ended) {
      return
    }
    this.#ended = true
    const endTimeUnixNano = toUnixNano(endTime ?? Date.now())
    this.#processor.onEnd(this.toSpanData(endTimeUnixNano))
  }

  isRecording(): boolean {
    return !this.#ended
  }

  private toSpanData(endTimeUnixNano: string): SpanData {
    return {
      traceId: this.#traceId,
      spanId: this.#spanId,
      parentSpanId: this.#parentSpanId,
      name: this.#name,
      kind: this.#kind,
      startTimeUnixNano: this.#startTimeUnixNano,
      endTimeUnixNano,
      attributes: this.#attributes,
      status: this.#status,
      events: this.#events.length > 0 ? this.#events : undefined,
      resourceAttributes: this.#resourceAttributes,
      scope: this.#scope,
    }
  }
}

class NoopSpan extends Span {
  constructor() {
    super({
      name: 'noop',
      kind: SpanKind.INTERNAL,
      startTimeUnixNano: toUnixNano(Date.now()),
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      resourceAttributes: {},
      scope: { name: 'noop' },
      processor: {
        onStart: () => {},
        onEnd: () => {},
        shutdown: async () => {},
        forceFlush: async () => {},
      },
    })
    super.end()
  }

  override end(): void {}

  override isRecording(): boolean {
    return false
  }
}

class NoopTracer {
  startSpan(): Span {
    return new NoopSpan()
  }
}

export class Tracer {
  readonly #resourceAttributes: SpanAttributes
  readonly #scope: { name: string; version?: string }
  readonly #processor: SpanProcessor

  constructor(options: {
    resourceAttributes: SpanAttributes
    scope: { name: string; version?: string }
    processor: SpanProcessor
  }) {
    this.#resourceAttributes = options.resourceAttributes
    this.#scope = options.scope
    this.#processor = options.processor
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const traceId = generateTraceId()
    const spanId = generateSpanId()
    return new Span({
      name,
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: options.attributes,
      startTimeUnixNano: toUnixNano(options.startTime ?? Date.now()),
      traceId,
      spanId,
      resourceAttributes: this.#resourceAttributes,
      scope: this.#scope,
      processor: this.#processor,
    })
  }
}

export class TracerProvider {
  readonly #resource: Resource
  readonly #processors: SpanProcessor[] = []
  readonly #tracers = new Map<string, Tracer>()

  constructor(options: { resource?: Resource } = {}) {
    this.#resource = options.resource ?? Resource.default()
  }

  addSpanProcessor(processor: SpanProcessor): void {
    this.#processors.push(processor)
  }

  getTracer(name: string, version?: string): Tracer {
    const key = `${name}:${version ?? ''}`
    const existing = this.#tracers.get(key)
    if (existing) {
      return existing
    }
    const processor =
      this.#processors.length === 1
        ? this.#processors[0]
        : {
            onStart: (span: SpanData) => {
              for (const proc of this.#processors) {
                proc.onStart(span)
              }
            },
            onEnd: (span: SpanData) => {
              for (const proc of this.#processors) {
                proc.onEnd(span)
              }
            },
            shutdown: async () => {
              await Promise.all(this.#processors.map((proc) => proc.shutdown()))
            },
            forceFlush: async () => {
              await Promise.all(this.#processors.map((proc) => proc.forceFlush()))
            },
          }
    const tracer = new Tracer({
      resourceAttributes: this.#resource.attributes,
      scope: { name, ...(version ? { version } : {}) },
      processor,
    })
    this.#tracers.set(key, tracer)
    return tracer
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.#processors.map((processor) => processor.shutdown()))
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#processors.map((processor) => processor.forceFlush()))
  }
}

export class NoopTracerProvider {
  getTracer(_name?: string, _version?: string): NoopTracer {
    return new NoopTracer()
  }
}

export const createSimpleSpanProcessor = (exporter: SpanExporter): SpanProcessor => new SimpleSpanProcessor(exporter)

export const spanAttributesKey = (attributes: SpanAttributes): string => stableAttributesKey(attributes)
