import type { MetricsExporterConfig, RuntimeTelemetryConfig } from '../config'
import type { Runtime } from '../internal/core-bridge/native'
import { native } from '../internal/core-bridge/native'

const buildMetricsExporterOptions = (exporter: MetricsExporterConfig | null) => {
  if (exporter === null) {
    return null
  }
  if (!exporter) {
    return undefined
  }
  if (exporter.type === 'prometheus') {
    const payload: Record<string, unknown> = {
      type: 'prometheus',
      socketAddr: exporter.socketAddr,
    }
    if (exporter.countersTotalSuffix !== undefined) {
      payload.countersTotalSuffix = exporter.countersTotalSuffix
    }
    if (exporter.unitSuffix !== undefined) {
      payload.unitSuffix = exporter.unitSuffix
    }
    if (exporter.useSecondsForDurations !== undefined) {
      payload.useSecondsForDurations = exporter.useSecondsForDurations
    }
    if (exporter.globalTags && Object.keys(exporter.globalTags).length > 0) {
      payload.globalTags = exporter.globalTags
    }
    if (exporter.histogramBucketOverrides && Object.keys(exporter.histogramBucketOverrides).length > 0) {
      payload.histogramBucketOverrides = exporter.histogramBucketOverrides
    }
    return payload
  }
  const payload: Record<string, unknown> = {
    type: 'otel',
    url: exporter.url,
  }
  if (exporter.protocol) {
    payload.protocol = exporter.protocol
  }
  if (exporter.metricPeriodicity !== undefined) {
    payload.metricPeriodicity = exporter.metricPeriodicity
  }
  if (exporter.metricTemporality) {
    payload.metricTemporality = exporter.metricTemporality
  }
  if (exporter.useSecondsForDurations !== undefined) {
    payload.useSecondsForDurations = exporter.useSecondsForDurations
  }
  if (exporter.headers && Object.keys(exporter.headers).length > 0) {
    payload.headers = exporter.headers
  }
  if (exporter.globalTags && Object.keys(exporter.globalTags).length > 0) {
    payload.globalTags = exporter.globalTags
  }
  if (exporter.histogramBucketOverrides && Object.keys(exporter.histogramBucketOverrides).length > 0) {
    payload.histogramBucketOverrides = exporter.histogramBucketOverrides
  }
  return payload
}

export const buildRuntimeTelemetryOptions = (telemetry?: RuntimeTelemetryConfig): Record<string, unknown> | null => {
  if (!telemetry) {
    return null
  }

  const options: Record<string, unknown> = {}

  if (telemetry.logFilter && telemetry.logFilter.length > 0) {
    options.logExporter = { filter: telemetry.logFilter }
  }

  const telemetrySettings: Record<string, unknown> = {}
  if (telemetry.metricPrefix !== undefined) {
    telemetrySettings.metricPrefix = telemetry.metricPrefix
  }
  if (telemetry.attachServiceName !== undefined) {
    telemetrySettings.attachServiceName = telemetry.attachServiceName
  }
  if (Object.keys(telemetrySettings).length > 0) {
    options.telemetry = telemetrySettings
  }

  if (telemetry.metricsExporter !== undefined) {
    const exporterOptions = buildMetricsExporterOptions(telemetry.metricsExporter)
    if (exporterOptions === null) {
      options.metricsExporter = null
    } else if (exporterOptions) {
      options.metricsExporter = exporterOptions
    }
  }

  return Object.keys(options).length === 0 ? null : options
}

export const configureRuntimeTelemetry = (runtime: Runtime, telemetry?: RuntimeTelemetryConfig): void => {
  const options = buildRuntimeTelemetryOptions(telemetry)
  if (!options) {
    return
  }
  native.configureTelemetry(runtime, options)
}
