import { describe, expect, it } from 'vitest'

import { resolveMetricsConfig } from '~/server/metrics-config'

describe('metrics-config', () => {
  it('disables metrics in test environments', () => {
    const config = resolveMetricsConfig({
      NODE_ENV: 'test',
      VITEST: '1',
    })

    expect(config.disabledForTest).toBe(true)
    expect(config.enabled).toBe(false)
  })

  it('normalizes exporter, endpoint, headers, and prometheus path', () => {
    const config = resolveMetricsConfig({
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer token',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'x-scope-id=jangar',
      JANGAR_PROMETHEUS_METRICS_PATH: 'internal-metrics',
      OTEL_SERVICE_NAME: 'jangar-api',
      POD_NAMESPACE: 'jangar',
      POD_NAME: 'jangar-0',
    })

    expect(config.metricsProtocol).toBe('http/protobuf')
    expect(config.metricsEndpoint).toBe('https://otel.example.com/v1/metrics')
    expect(config.headers).toEqual({
      authorization: 'Bearer token',
      'x-scope-id': 'jangar',
    })
    expect(config.prometheusPath).toBe('/internal-metrics')
    expect(config.serviceName).toBe('jangar-api')
    expect(config.serviceNamespace).toBe('jangar')
    expect(config.serviceInstanceId).toBe('jangar-0')
  })

  it('can disable all metrics exporters explicitly', () => {
    const config = resolveMetricsConfig({
      OTEL_METRICS_EXPORTER: 'none',
      JANGAR_PROMETHEUS_METRICS_ENABLED: 'false',
    })

    expect(config.otlpEnabled).toBe(false)
    expect(config.prometheusEnabled).toBe(false)
    expect(config.enabled).toBe(false)
  })
})
