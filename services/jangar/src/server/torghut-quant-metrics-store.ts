import { sql } from 'kysely'

import { getDb } from './db'
import { ensureMigrations } from './kysely-migrations'
import type { QuantAlert, QuantMetric, QuantWindow } from './torghut-quant-contract'

type QuantLatestRow = {
  strategy_id: string
  account: string
  window: QuantWindow
  metric_name: string
  status: string
  quality: string
  unit: string
  value_numeric: number | null
  value_json: Record<string, unknown>
  meta_json: Record<string, unknown>
  formula_version: string
  as_of: Date
  freshness_seconds: number
}

const toDate = (value: string) => new Date(value)

export const ensureQuantStoreReady = async () => {
  const db = getDb()
  if (!db) throw new Error('Jangar database is not configured (DATABASE_URL missing)')
  await ensureMigrations(db)
  return db
}

export const upsertQuantLatestMetrics = async (params: {
  strategyId: string
  account: string
  window: QuantWindow
  metrics: QuantMetric[]
}) => {
  const db = await ensureQuantStoreReady()
  const rows: QuantLatestRow[] = params.metrics.map((metric) => ({
    strategy_id: params.strategyId,
    account: params.account,
    window: params.window,
    metric_name: metric.metricName,
    status: metric.status,
    quality: metric.quality,
    unit: metric.unit,
    value_numeric: metric.valueNumeric,
    value_json: metric.valueJson ?? {},
    meta_json: metric.meta ?? {},
    formula_version: metric.formulaVersion,
    as_of: toDate(metric.asOf),
    freshness_seconds: metric.freshnessSeconds,
  }))

  if (rows.length === 0) return

  await db
    .insertInto('torghut_control_plane.quant_metrics_latest')
    .values(rows)
    .onConflict((oc) =>
      oc.columns(['strategy_id', 'account', 'window', 'metric_name']).doUpdateSet((eb) => ({
        status: eb.ref('excluded.status'),
        quality: eb.ref('excluded.quality'),
        unit: eb.ref('excluded.unit'),
        value_numeric: eb.ref('excluded.value_numeric'),
        value_json: eb.ref('excluded.value_json'),
        meta_json: eb.ref('excluded.meta_json'),
        formula_version: eb.ref('excluded.formula_version'),
        as_of: eb.ref('excluded.as_of'),
        freshness_seconds: eb.ref('excluded.freshness_seconds'),
        updated_at: sql`now()`,
      })),
    )
    .execute()
}

export const appendQuantSeriesMetrics = async (params: {
  strategyId: string
  account: string
  window: QuantWindow
  metrics: QuantMetric[]
}) => {
  const db = await ensureQuantStoreReady()
  if (params.metrics.length === 0) return

  await db
    .insertInto('torghut_control_plane.quant_metrics_series')
    .values(
      params.metrics.map((metric) => ({
        strategy_id: params.strategyId,
        account: params.account,
        window: params.window,
        metric_name: metric.metricName,
        status: metric.status,
        quality: metric.quality,
        unit: metric.unit,
        value_numeric: metric.valueNumeric,
        value_json: metric.valueJson ?? {},
        meta_json: metric.meta ?? {},
        formula_version: metric.formulaVersion,
        as_of: toDate(metric.asOf),
        freshness_seconds: metric.freshnessSeconds,
      })),
    )
    .execute()
}

export const listQuantLatestMetrics = async (params: { strategyId: string; account: string; window: QuantWindow }) => {
  const db = await ensureQuantStoreReady()
  const rows = await db
    .selectFrom('torghut_control_plane.quant_metrics_latest')
    .select([
      'metric_name',
      'window',
      'status',
      'quality',
      'unit',
      'value_numeric',
      'value_json',
      'meta_json',
      'formula_version',
      'as_of',
      'freshness_seconds',
    ])
    .where('strategy_id', '=', params.strategyId)
    .where('account', '=', params.account)
    .where('window', '=', params.window)
    .orderBy('metric_name', 'asc')
    .execute()

  return rows.map((row) => ({
    metricName: row.metric_name,
    window: row.window as QuantWindow,
    status: row.status as QuantMetric['status'],
    quality: row.quality as QuantMetric['quality'],
    unit: row.unit,
    valueNumeric: row.value_numeric === null ? null : Number(row.value_numeric),
    valueJson: (row.value_json as Record<string, unknown>) ?? {},
    meta: (row.meta_json as Record<string, unknown>) ?? {},
    formulaVersion: row.formula_version,
    asOf: new Date(row.as_of as unknown as string | Date).toISOString(),
    freshnessSeconds: row.freshness_seconds,
  })) satisfies QuantMetric[]
}

export const listQuantSeriesMetrics = async (params: {
  strategyId: string
  account: string
  window: QuantWindow
  metricNames: string[]
  fromUtc: string
  toUtc: string
  limit?: number
}) => {
  const db = await ensureQuantStoreReady()
  const limit = Math.max(1, Math.min(params.limit ?? 25_000, 100_000))
  const metricNames = params.metricNames.map((name) => name.trim()).filter(Boolean)
  if (metricNames.length === 0) return []

  const rows = await db
    .selectFrom('torghut_control_plane.quant_metrics_series')
    .select([
      'metric_name',
      'window',
      'status',
      'quality',
      'unit',
      'value_numeric',
      'value_json',
      'meta_json',
      'formula_version',
      'as_of',
      'freshness_seconds',
    ])
    .where('strategy_id', '=', params.strategyId)
    .where('account', '=', params.account)
    .where('window', '=', params.window)
    .where('metric_name', 'in', metricNames)
    .where('as_of', '>=', toDate(params.fromUtc))
    .where('as_of', '<=', toDate(params.toUtc))
    .orderBy('as_of', 'asc')
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    metricName: row.metric_name,
    window: row.window as QuantWindow,
    status: row.status as QuantMetric['status'],
    quality: row.quality as QuantMetric['quality'],
    unit: row.unit,
    valueNumeric: row.value_numeric === null ? null : Number(row.value_numeric),
    valueJson: (row.value_json as Record<string, unknown>) ?? {},
    meta: (row.meta_json as Record<string, unknown>) ?? {},
    formulaVersion: row.formula_version,
    asOf: new Date(row.as_of as unknown as string | Date).toISOString(),
    freshnessSeconds: row.freshness_seconds,
  })) satisfies QuantMetric[]
}

export const upsertQuantAlerts = async (params: { alerts: QuantAlert[] }) => {
  const db = await ensureQuantStoreReady()
  if (params.alerts.length === 0) return

  await db
    .insertInto('torghut_control_plane.quant_alerts')
    .values(
      params.alerts.map((alert) => ({
        alert_id: alert.alertId,
        strategy_id: alert.strategyId,
        account: alert.account,
        severity: alert.severity,
        metric_name: alert.metricName,
        window: alert.window,
        threshold_json: alert.threshold,
        observed_json: alert.observed,
        opened_at: toDate(alert.openedAt),
        resolved_at: alert.resolvedAt ? toDate(alert.resolvedAt) : null,
        state: alert.state,
      })),
    )
    .onConflict((oc) =>
      oc.column('alert_id').doUpdateSet((eb) => ({
        severity: eb.ref('excluded.severity'),
        metric_name: eb.ref('excluded.metric_name'),
        window: eb.ref('excluded.window'),
        threshold_json: eb.ref('excluded.threshold_json'),
        observed_json: eb.ref('excluded.observed_json'),
        resolved_at: eb.ref('excluded.resolved_at'),
        state: eb.ref('excluded.state'),
        updated_at: sql`now()`,
      })),
    )
    .execute()
}

export const listQuantAlerts = async (params: { strategyId?: string; state?: 'open' | 'resolved'; limit?: number }) => {
  const db = await ensureQuantStoreReady()
  const limit = Math.max(1, Math.min(params.limit ?? 500, 5_000))
  let query = db
    .selectFrom('torghut_control_plane.quant_alerts')
    .select([
      'alert_id',
      'strategy_id',
      'account',
      'severity',
      'metric_name',
      'window',
      'threshold_json',
      'observed_json',
      'opened_at',
      'resolved_at',
      'state',
    ])
    .orderBy('opened_at', 'desc')
    .limit(limit)

  if (params.strategyId) {
    query = query.where('strategy_id', '=', params.strategyId)
  }
  if (params.state) {
    query = query.where('state', '=', params.state)
  }

  const rows = await query.execute()
  return rows.map((row) => ({
    alertId: row.alert_id,
    strategyId: row.strategy_id,
    account: row.account,
    severity: (row.severity as QuantAlert['severity']) ?? 'warning',
    metricName: row.metric_name,
    window: row.window as QuantWindow,
    threshold: (row.threshold_json as Record<string, unknown>) ?? {},
    observed: (row.observed_json as Record<string, unknown>) ?? {},
    openedAt: new Date(row.opened_at as unknown as string | Date).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as unknown as string | Date).toISOString() : null,
    state: (row.state as QuantAlert['state']) ?? 'open',
  })) satisfies QuantAlert[]
}
