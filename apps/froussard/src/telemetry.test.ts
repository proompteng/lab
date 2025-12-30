import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setLoggerMock = vi.fn()
const diagConsoleLoggerMock = vi.fn()

vi.mock('@opentelemetry/api', () => ({
  diag: { setLogger: setLoggerMock },
  DiagConsoleLogger: diagConsoleLoggerMock,
  DiagLogLevel: { ERROR: 'ERROR' },
}))

const autoInstrumentationMock = vi.fn().mockReturnValue([{ name: 'http' }])
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: autoInstrumentationMock,
}))

const traceExporterMock = vi.fn().mockImplementation((config: unknown) => ({ config }))
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: traceExporterMock,
}))

const metricExporterMock = vi.fn().mockImplementation((config: unknown) => ({ config }))
vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: metricExporterMock,
}))

const metricReaderMock = vi.fn().mockImplementation((config: unknown) => ({ config }))
vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: metricReaderMock,
  MetricReader: class {},
}))

const nodeSdkStartMock = vi.fn().mockResolvedValue(undefined)
const nodeSdkShutdownMock = vi.fn().mockResolvedValue(undefined)
const nodeSdkCtorMock = vi.fn().mockImplementation((config: unknown) => ({
  config,
  start: nodeSdkStartMock,
  shutdown: nodeSdkShutdownMock,
}))

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: nodeSdkCtorMock,
}))

class MockResource {
  constructor(readonly attributes: Record<string, unknown> = {}) {}

  static default() {
    return new MockResource({})
  }

  merge(other: MockResource) {
    return new MockResource({ ...this.attributes, ...other.attributes })
  }
}

vi.mock('@opentelemetry/resources', () => ({
  Resource: MockResource,
}))

vi.mock('@opentelemetry/semantic-conventions', () => ({
  SEMRESATTRS_SERVICE_NAME: 'service.name',
  SEMRESATTRS_SERVICE_NAMESPACE: 'service.namespace',
  SEMRESATTRS_SERVICE_INSTANCE_ID: 'service.instance.id',
}))

const originalEnv = { ...process.env }

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value
  }
}

let processOnSpy: ReturnType<typeof vi.spyOn>
let processOnceSpy: ReturnType<typeof vi.spyOn>

describe('telemetry', () => {
  const globalContext = globalThis as typeof globalThis & {
    __froussardTelemetryState?: unknown
  }

  beforeEach(() => {
    vi.resetModules()
    resetEnv()
    delete globalContext.__froussardTelemetryState
    nodeSdkCtorMock.mockClear()
    nodeSdkStartMock.mockClear()
    nodeSdkShutdownMock.mockClear()
    traceExporterMock.mockClear()
    metricExporterMock.mockClear()
    metricReaderMock.mockClear()
    autoInstrumentationMock.mockClear()
    setLoggerMock.mockClear()
    diagConsoleLoggerMock.mockClear()
    const processHandle = process as unknown as {
      on: (...args: unknown[]) => unknown
      once: (...args: unknown[]) => unknown
    }
    processOnSpy = vi.spyOn(processHandle, 'on').mockImplementation(() => processHandle)
    processOnceSpy = vi.spyOn(processHandle, 'once').mockImplementation(() => processHandle)
  })

  afterEach(() => {
    processOnSpy.mockRestore()
    processOnceSpy.mockRestore()
    resetEnv()
    delete globalContext.__froussardTelemetryState
  })

  it('initialises NodeSDK with provided LGTM endpoints and resource metadata', async () => {
    process.env.LGTM_TEMPO_TRACES_ENDPOINT = 'http://tempo:4318/v1/traces'
    process.env.LGTM_MIMIR_METRICS_ENDPOINT = 'http://mimir/otlp'
    process.env.OTEL_METRIC_EXPORT_INTERVAL = '2500'
    process.env.OTEL_SERVICE_NAME = 'froussard'
    process.env.OTEL_SERVICE_NAMESPACE = 'froussard'
    process.env.POD_NAME = 'froussard-123'

    const module = await import('./telemetry')

    expect(nodeSdkCtorMock).toHaveBeenCalledTimes(1)
    const [call] = nodeSdkCtorMock.mock.calls
    if (!call) {
      throw new Error('NodeSDK constructor was not called')
    }
    const config = call[0] as { resource: MockResource }

    expect(config.resource.attributes).toMatchObject({
      'service.name': 'froussard',
      'service.namespace': 'froussard',
      'service.instance.id': 'froussard-123',
    })

    expect(traceExporterMock).toHaveBeenCalledWith({
      url: 'http://tempo:4318/v1/traces',
      headers: undefined,
    })

    expect(metricExporterMock).toHaveBeenCalledWith({
      url: 'http://mimir/otlp',
      headers: undefined,
    })

    expect(metricReaderMock).toHaveBeenCalledWith({
      exporter: expect.any(Object),
      exportIntervalMillis: 5000,
    })

    expect(autoInstrumentationMock).toHaveBeenCalledTimes(1)
    expect(nodeSdkStartMock).toHaveBeenCalledTimes(1)
    expect(module.telemetrySdk).toMatchObject({ config })
    expect(processOnceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })

  it('falls back to host metadata when POD_NAME is not set', async () => {
    process.env.OTEL_SERVICE_NAME = 'froussard'
    process.env.OTEL_SERVICE_NAMESPACE = 'froussard'
    process.env.HOSTNAME = 'froussard-host'

    await import('./telemetry')

    expect(nodeSdkCtorMock).toHaveBeenCalledTimes(1)
    const [call] = nodeSdkCtorMock.mock.calls
    if (!call) {
      throw new Error('NodeSDK constructor was not called')
    }
    const config = call[0] as { resource: MockResource }

    expect(config.resource.attributes).toMatchObject({
      'service.instance.id': 'froussard-host',
    })
  })

  it('falls back to default observability endpoints when environment variables are unset', async () => {
    await import('./telemetry')

    expect(traceExporterMock).toHaveBeenCalledWith({
      url: 'http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces',
      headers: undefined,
    })

    expect(metricExporterMock).toHaveBeenCalledWith({
      url: 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics',
      headers: undefined,
    })
  })

  it('parses exporter headers from environment variables', async () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'global=alpha,shared=bravo'
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'trace=charlie'
    process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'metric=delta'

    await import('./telemetry')

    expect(traceExporterMock).toHaveBeenCalledWith({
      url: 'http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces',
      headers: expect.objectContaining({ global: 'alpha', shared: 'bravo', trace: 'charlie' }),
    })

    expect(metricExporterMock).toHaveBeenCalledWith({
      url: 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics',
      headers: expect.objectContaining({ global: 'alpha', shared: 'bravo', metric: 'delta' }),
    })
  })
})
