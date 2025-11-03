import { describe, expect, it } from 'bun:test'
import { loadTemporalConfig, temporalDefaults } from '../src/config'

describe('loadTemporalConfig', () => {
  it('returns default configuration when env is empty', async () => {
    const config = await loadTemporalConfig({ env: {} })
    expect(config.host).toBe(temporalDefaults.host)
    expect(config.port).toBe(temporalDefaults.port)
    expect(config.namespace).toBe(temporalDefaults.namespace)
    expect(config.taskQueue).toBe(temporalDefaults.taskQueue)
    expect(config.address).toBe(`${temporalDefaults.host}:${temporalDefaults.port}`)
    expect(config.allowInsecureTls).toBe(false)
    expect(config.tls).toBeUndefined()
  })

  it('parses address, namespace, queue, API key, TLS, and insecure flags from env', async () => {
    const env = {
      TEMPORAL_HOST: 'temporal.example.internal',
      TEMPORAL_GRPC_PORT: '7433',
      TEMPORAL_NAMESPACE: 'analytics',
      TEMPORAL_TASK_QUEUE: 'analytics-tasks',
      TEMPORAL_API_KEY: 'test-key',
      TEMPORAL_TLS_CA_PATH: '/tmp/ca.pem',
      TEMPORAL_TLS_CERT_PATH: '/tmp/cert.pem',
      TEMPORAL_TLS_KEY_PATH: '/tmp/key.pem',
      TEMPORAL_TLS_SERVER_NAME: 'temporal.example.internal',
      TEMPORAL_ALLOW_INSECURE: 'false',
    }

    const files: Record<string, string> = {
      '/tmp/ca.pem': 'CA',
      '/tmp/cert.pem': 'CERT',
      '/tmp/key.pem': 'KEY',
    }

    const config = await loadTemporalConfig({
      env,
      fs: {
        readFile: async (path) => {
          const contents = files[path]
          if (!contents) throw new Error(`File not found in test fixture: ${path}`)
          return Buffer.from(contents, 'utf8')
        },
      },
    })

    expect(config.host).toBe('temporal.example.internal')
    expect(config.port).toBe(7433)
    expect(config.address).toBe('temporal.example.internal:7433')
    expect(config.namespace).toBe('analytics')
    expect(config.taskQueue).toBe('analytics-tasks')
    expect(config.apiKey).toBe('test-key')
    expect(config.allowInsecureTls).toBe(false)
    expect(config.tls?.serverRootCACertificate?.toString('utf8')).toBe('CA')
    expect(config.tls?.clientCertPair?.crt.toString('utf8')).toBe('CERT')
    expect(config.tls?.clientCertPair?.key.toString('utf8')).toBe('KEY')
    expect(config.tls?.serverNameOverride).toBe('temporal.example.internal')
  })

  it('honors TEMPORAL_ALLOW_INSECURE shorthand booleans', async () => {
    const config = await loadTemporalConfig({
      env: {
        TEMPORAL_ALLOW_INSECURE: '1',
      },
    })
    expect(config.allowInsecureTls).toBe(true)
  })

  it('parses telemetry env overrides for Prometheus exporter', async () => {
    const env = {
      TEMPORAL_LOG_FILTER: 'debug',
      TEMPORAL_METRICS_PREFIX: 'bun-sdk',
      TEMPORAL_METRICS_ATTACH_SERVICE_NAME: 'true',
      TEMPORAL_METRICS_EXPORTER: 'prometheus',
      TEMPORAL_PROMETHEUS_ENDPOINT: '127.0.0.1:9464',
      TEMPORAL_PROMETHEUS_COUNTERS_TOTAL_SUFFIX: '0',
      TEMPORAL_PROMETHEUS_UNIT_SUFFIX: '1',
      TEMPORAL_PROMETHEUS_USE_SECONDS: 'true',
      TEMPORAL_METRICS_GLOBAL_TAGS: '{"service":"sdk","env":"test"}',
      TEMPORAL_METRICS_HISTOGRAM_OVERRIDES: '{"temporal_activity_schedule_to_start_latency":[1,5,10]}',
    }

  const config = await loadTemporalConfig({ env: env as unknown as NodeJS.ProcessEnv })

    expect(config.telemetry).toBeDefined()
    expect(config.telemetry?.logFilter).toBe('debug')
    expect(config.telemetry?.metricPrefix).toBe('bun-sdk')
    expect(config.telemetry?.attachServiceName).toBe(true)
    expect(config.telemetry?.metricsExporter).toEqual({
      type: 'prometheus',
      socketAddr: '127.0.0.1:9464',
      countersTotalSuffix: false,
      unitSuffix: true,
      useSecondsForDurations: true,
      globalTags: {
        service: 'sdk',
        env: 'test',
      },
      histogramBucketOverrides: {
        temporal_activity_schedule_to_start_latency: [1, 5, 10],
      },
    })
  })

  it('merges telemetry defaults with OTLP overrides', async () => {
    const env = {
      TEMPORAL_METRICS_EXPORTER: 'otlp',
      TEMPORAL_OTLP_ENDPOINT: 'http://collector:4318',
      TEMPORAL_OTLP_PROTOCOL: 'http',
      TEMPORAL_OTLP_METRIC_TEMPORALITY: 'delta',
      TEMPORAL_METRICS_GLOBAL_TAGS: '{"service":"sdk"}',
      TEMPORAL_METRICS_HISTOGRAM_OVERRIDES: '{"custom":[0.1,1,10]}',
    }

    const config = await loadTemporalConfig({
  env: env as unknown as NodeJS.ProcessEnv,
      defaults: {
        telemetry: {
          logFilter: 'info',
          metricPrefix: 'default',
          metricsExporter: {
            type: 'otel',
            url: 'http://default:4318',
            metricPeriodicity: 60000,
          },
        },
      },
    })

    expect(config.telemetry?.logFilter).toBe('info')
    expect(config.telemetry?.metricPrefix).toBe('default')
    expect(config.telemetry?.metricsExporter).toEqual({
      type: 'otel',
      url: 'http://collector:4318',
      protocol: 'http',
      metricPeriodicity: 60000,
      metricTemporality: 'delta',
      globalTags: { service: 'sdk' },
      histogramBucketOverrides: { custom: [0.1, 1, 10] },
    })
  })
})
