export type QuantWindow = '1m' | '5m' | '15m' | '1h' | '1d' | '5d' | '20d'

export type QuantMetricStatus = 'ok' | 'insufficient_data' | 'error'

export type QuantMetricQuality = 'good' | 'stale' | 'insufficient_data' | 'error'

export type QuantMetricValue = {
  valueNumeric: number | null
  valueJson?: Record<string, unknown>
  meta?: Record<string, unknown>
}

export type QuantMetric = QuantMetricValue & {
  metricName: string
  window: QuantWindow
  unit: string
  status: QuantMetricStatus
  quality: QuantMetricQuality
  formulaVersion: string
  asOf: string
  freshnessSeconds: number
}

export type QuantAlertState = 'open' | 'resolved'

export type QuantAlert = {
  alertId: string
  strategyId: string
  account: string
  severity: 'warning' | 'critical'
  metricName: string
  window: QuantWindow
  threshold: Record<string, unknown>
  observed: Record<string, unknown>
  openedAt: string
  resolvedAt: string | null
  state: QuantAlertState
}

export type QuantSnapshotFrame = {
  strategyId: string
  account: string
  window: QuantWindow
  frameAsOf: string
  metrics: QuantMetric[]
  alerts: QuantAlert[]
}

export const QUANT_WINDOWS: QuantWindow[] = ['1m', '5m', '15m', '1h', '1d', '5d', '20d']

export const isQuantWindow = (value: string | null): value is QuantWindow =>
  Boolean(value && (QUANT_WINDOWS as string[]).includes(value))
