import type { Pool } from 'pg'
import type { QuantMetric, QuantMetricQuality, QuantMetricStatus, QuantWindow } from './torghut-quant-contract'
import { computeWindowBoundsUtc } from './torghut-quant-windows'
import { listTorghutTradingFilledExecutions, type TorghutStrategyRow } from './torghut-trading'
import { computeRealizedPnlAverageCostLongOnly } from './torghut-trading-pnl'

export const TORGHUT_QUANT_FORMULA_VERSION = 'v1.0.0'

type PositionSnapshotWithPositions = {
  asOf: string
  alpacaAccountLabel: string
  equity: number
  cash: number
  buyingPower: number
  positions: unknown
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const safeArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const secondsBetween = (nowMs: number, asOfIso: string) => {
  const asOfMs = Date.parse(asOfIso)
  if (Number.isNaN(asOfMs)) return 0
  return Math.max(0, Math.floor((nowMs - asOfMs) / 1000))
}

const resolveQuality = (status: QuantMetricStatus, freshnessSeconds: number, maxStalenessSeconds: number) => {
  if (status === 'insufficient_data') return 'insufficient_data' satisfies QuantMetricQuality
  if (status === 'error') return 'error' satisfies QuantMetricQuality
  if (freshnessSeconds > maxStalenessSeconds) return 'stale' satisfies QuantMetricQuality
  return 'good' satisfies QuantMetricQuality
}

const buildMetric = (params: {
  metricName: string
  window: QuantWindow
  unit: string
  valueNumeric: number | null
  asOf: string
  status?: QuantMetricStatus
  valueJson?: Record<string, unknown>
  meta?: Record<string, unknown>
  nowMs: number
  maxStalenessSeconds: number
}): QuantMetric => {
  const status = params.status ?? (params.valueNumeric === null ? 'insufficient_data' : 'ok')
  const freshnessSeconds = secondsBetween(params.nowMs, params.asOf)
  return {
    metricName: params.metricName,
    window: params.window,
    unit: params.unit,
    valueNumeric: params.valueNumeric,
    valueJson: params.valueJson,
    meta: params.meta,
    status,
    quality: resolveQuality(status, freshnessSeconds, params.maxStalenessSeconds),
    formulaVersion: TORGHUT_QUANT_FORMULA_VERSION,
    asOf: params.asOf,
    freshnessSeconds,
  }
}

export const listTorghutStrategyAccounts = async (params: {
  pool: Pool
  strategyId: string
  limit?: number
}): Promise<string[]> => {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 500))
  const result = await params.pool.query(
    `
      select distinct td.alpaca_account_label as alpaca_account_label
      from trade_decisions td
      where td.strategy_id = $1::uuid
      order by td.alpaca_account_label asc
      limit $2
    `,
    [params.strategyId, limit],
  )
  return result.rows
    .map((row) => (row.alpaca_account_label ? String(row.alpaca_account_label).trim() : ''))
    .filter(Boolean)
}

export const getTorghutLatestPositionSnapshot = async (params: {
  pool: Pool
  account: string
  beforeUtc: string
}): Promise<PositionSnapshotWithPositions | null> => {
  const account = params.account.trim()
  if (!account) return null

  const result = await params.pool.query(
    `
      select
        as_of,
        alpaca_account_label,
        equity,
        cash,
        buying_power,
        positions
      from position_snapshots
      where alpaca_account_label = $1
        and as_of <= $2
      order by as_of desc
      limit 1
    `,
    [account, params.beforeUtc],
  )

  const row = result.rows[0]
  if (!row) return null
  const equity = toNumber(row.equity)
  const cash = toNumber(row.cash)
  const buyingPower = toNumber(row.buying_power)
  if (equity === null || cash === null || buyingPower === null) return null
  return {
    asOf: new Date(row.as_of as string | Date).toISOString(),
    alpacaAccountLabel: String(row.alpaca_account_label),
    equity,
    cash,
    buyingPower,
    positions: row.positions ?? null,
  }
}

export const listTorghutEquitySeries = async (params: {
  pool: Pool
  account: string
  startUtc: string
  endUtc: string
  limit?: number
}): Promise<Array<{ asOf: string; equity: number }>> => {
  const limit = Math.max(1, Math.min(params.limit ?? 10_000, 100_000))
  const result = await params.pool.query(
    `
      select as_of, equity
      from position_snapshots
      where alpaca_account_label = $1
        and as_of >= $2
        and as_of < $3
      order by as_of asc
      limit $4
    `,
    [params.account, params.startUtc, params.endUtc, limit],
  )

  return result.rows
    .map((row) => {
      const equity = toNumber(row.equity)
      if (equity === null) return null
      return { asOf: new Date(row.as_of as string | Date).toISOString(), equity }
    })
    .filter((row): row is { asOf: string; equity: number } => row !== null)
}

const computeReturns = (series: Array<{ asOf: string; equity: number }>) => {
  const returns: number[] = []
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1]
    const next = series[i]
    if (!prev || !next) continue
    if (prev.equity <= 0) continue
    returns.push(next.equity / prev.equity - 1)
  }
  return returns
}

const mean = (values: number[]) => {
  if (values.length === 0) return null
  const sum = values.reduce((acc, value) => acc + value, 0)
  return sum / values.length
}

const stddev = (values: number[]) => {
  if (values.length < 2) return null
  const mu = mean(values)
  if (mu === null) return null
  const variance = values.reduce((acc, value) => acc + (value - mu) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

const annualizationFactor = (sampleSeconds: number | null) => {
  // Approximate equity snapshots at minute cadence during market hours.
  // We prefer to be explicit but conservative; dashboards surface meta to avoid false precision.
  const seconds = sampleSeconds && sampleSeconds > 0 ? sampleSeconds : 60
  const periodsPerDay = Math.floor((6.5 * 60 * 60) / seconds)
  const periodsPerYear = 252 * Math.max(1, periodsPerDay)
  return { periodsPerYear, sampleSeconds: seconds }
}

const computeMaxDrawdown = (series: Array<{ asOf: string; equity: number }>) => {
  let peak = -Infinity
  let maxDrawdown = 0
  let peakTs: string | null = null
  let troughTs: string | null = null

  for (const point of series) {
    if (point.equity > peak) {
      peak = point.equity
      peakTs = point.asOf
    }
    if (peak > 0) {
      const drawdown = point.equity / peak - 1
      if (drawdown < maxDrawdown) {
        maxDrawdown = drawdown
        troughTs = point.asOf
      }
    }
  }

  const durationMinutes =
    peakTs && troughTs ? Math.max(0, Math.floor((Date.parse(troughTs) - Date.parse(peakTs)) / 60_000)) : null

  return { maxDrawdown, drawdownDurationMinutes: durationMinutes, peakTs, troughTs }
}

const inferSnapshotSampleSeconds = (series: Array<{ asOf: string; equity: number }>) => {
  if (series.length < 3) return null
  const deltas: number[] = []
  for (let i = 1; i < Math.min(series.length, 20); i += 1) {
    const prev = series[i - 1]
    const next = series[i]
    if (!prev || !next) continue
    const delta = Math.floor((Date.parse(next.asOf) - Date.parse(prev.asOf)) / 1000)
    if (Number.isFinite(delta) && delta > 0) deltas.push(delta)
  }
  if (deltas.length === 0) return null
  deltas.sort((a, b) => a - b)
  return deltas[Math.floor(deltas.length / 2)] ?? null
}

const computeExposure = (positions: unknown) => {
  const items = safeArray(positions)
  let gross = 0
  let net = 0
  const positionNotionals: number[] = []

  for (const raw of items) {
    const pos = asRecord(raw)
    if (!pos) continue
    const marketValue = toNumber(pos.market_value) ?? toNumber(pos.marketValue)
    if (marketValue === null) continue
    net += marketValue
    gross += Math.abs(marketValue)
    positionNotionals.push(Math.abs(marketValue))
  }

  positionNotionals.sort((a, b) => b - a)
  const top1 = positionNotionals[0] ?? 0
  const top5 = positionNotionals.slice(0, 5).reduce((acc, v) => acc + v, 0)

  const top1Pct = gross > 0 ? top1 / gross : null
  const top5Pct = gross > 0 ? top5 / gross : null

  // HHI on absolute weights.
  let hhi = 0
  if (gross > 0) {
    for (const notional of positionNotionals) {
      const w = notional / gross
      hhi += w * w
    }
  } else {
    hhi = 0
  }

  return { grossExposure: gross, netExposure: net, top1Pct, top5Pct, hhi, positionCount: items.length }
}

const computeUnrealizedPnl = (positions: unknown) => {
  const items = safeArray(positions)
  let unrealized = 0
  let okCount = 0

  for (const raw of items) {
    const pos = asRecord(raw)
    if (!pos) continue
    const v =
      toNumber(pos.unrealized_pl) ??
      toNumber(pos.unrealizedPl) ??
      toNumber(pos.unrealized_profit_loss) ??
      toNumber(pos.unrealizedProfitLoss)
    if (v === null) continue
    unrealized += v
    okCount += 1
  }
  return { unrealizedPnl: okCount > 0 ? unrealized : null, positionRows: okCount }
}

export const __private = {
  computeExposure,
  computeMaxDrawdown,
}

export const computeTorghutQuantMetrics = async (params: {
  pool: Pool
  strategy: Pick<TorghutStrategyRow, 'id' | 'name'>
  account: string
  window: QuantWindow
  now?: Date
  maxStalenessSeconds: number
}) => {
  const now = params.now ?? new Date()
  const nowMs = now.getTime()
  const bounds = computeWindowBoundsUtc(params.window, now)

  const executions = await listTorghutTradingFilledExecutions({
    pool: params.pool,
    startUtc: bounds.startUtc,
    endUtc: bounds.endUtc,
    strategyId: params.strategy.id,
    limit: 10_000,
  })

  const account = params.account.trim()
  const filteredExecutions = account
    ? executions.filter((row) => (row.alpacaAccountLabel ?? '').trim() === account)
    : executions

  const realized = computeRealizedPnlAverageCostLongOnly(filteredExecutions)
  const tradeCount = filteredExecutions.length
  const latestExecutionTs = filteredExecutions.at(-1)?.createdAt ?? bounds.startUtc

  const equitySeries = account
    ? await listTorghutEquitySeries({
        pool: params.pool,
        account,
        startUtc: bounds.startUtc,
        endUtc: bounds.endUtc,
        limit: 10_000,
      })
    : []
  const latestEquityTs =
    equitySeries.length > 0 ? (equitySeries[equitySeries.length - 1]?.asOf ?? bounds.startUtc) : bounds.startUtc
  const startEquity = equitySeries[0]?.equity ?? null
  const endEquity = equitySeries.length > 0 ? (equitySeries[equitySeries.length - 1]?.equity ?? null) : null
  const cumulativeReturn = startEquity && endEquity ? endEquity / startEquity - 1 : null

  const returns = computeReturns(equitySeries)
  const sampleSeconds = inferSnapshotSampleSeconds(equitySeries)
  const ann = annualizationFactor(sampleSeconds)
  const mu = mean(returns)
  const sigma = stddev(returns)
  const volatilityAnnualized = sigma !== null ? sigma * Math.sqrt(ann.periodsPerYear) : null
  const sharpeAnnualized = mu !== null && sigma && sigma > 0 ? (mu / sigma) * Math.sqrt(ann.periodsPerYear) : null

  const drawdown = computeMaxDrawdown(equitySeries)

  const latestSnapshot = account
    ? await getTorghutLatestPositionSnapshot({ pool: params.pool, account, beforeUtc: bounds.endUtc })
    : null
  const exposure = latestSnapshot ? computeExposure(latestSnapshot.positions) : null
  const unrealized = latestSnapshot ? computeUnrealizedPnl(latestSnapshot.positions) : null

  const metrics: QuantMetric[] = []

  metrics.push(
    buildMetric({
      metricName: 'realized_pnl',
      window: params.window,
      unit: 'USD',
      valueNumeric: Number.isFinite(realized.realizedPnl) ? realized.realizedPnl : null,
      valueJson: { winRate: realized.winRate, winCount: realized.winCount, lossCount: realized.lossCount },
      asOf: latestExecutionTs,
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  metrics.push(
    buildMetric({
      metricName: 'trade_count',
      window: params.window,
      unit: 'count',
      valueNumeric: tradeCount,
      asOf: latestExecutionTs,
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  metrics.push(
    buildMetric({
      metricName: 'win_rate',
      window: params.window,
      unit: 'ratio',
      valueNumeric: realized.winRate ?? null,
      asOf: latestExecutionTs,
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  metrics.push(
    buildMetric({
      metricName: 'cumulative_return',
      window: params.window,
      unit: 'ratio',
      valueNumeric: cumulativeReturn,
      asOf: latestEquityTs,
      meta: { sampleSeconds: ann.sampleSeconds, periodsPerYear: ann.periodsPerYear },
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  metrics.push(
    buildMetric({
      metricName: 'volatility_annualized',
      window: params.window,
      unit: 'ratio',
      valueNumeric: volatilityAnnualized,
      asOf: latestEquityTs,
      meta: { sampleSeconds: ann.sampleSeconds, periodsPerYear: ann.periodsPerYear },
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  metrics.push(
    buildMetric({
      metricName: 'sharpe_annualized',
      window: params.window,
      unit: 'ratio',
      valueNumeric: sharpeAnnualized,
      asOf: latestEquityTs,
      meta: { sampleSeconds: ann.sampleSeconds, periodsPerYear: ann.periodsPerYear },
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  metrics.push(
    buildMetric({
      metricName: 'max_drawdown',
      window: params.window,
      unit: 'ratio',
      valueNumeric: equitySeries.length > 1 ? drawdown.maxDrawdown : null,
      asOf: latestEquityTs,
      valueJson: { peakTs: drawdown.peakTs, troughTs: drawdown.troughTs },
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  metrics.push(
    buildMetric({
      metricName: 'drawdown_duration_minutes',
      window: params.window,
      unit: 'minutes',
      valueNumeric: drawdown.drawdownDurationMinutes === null ? null : drawdown.drawdownDurationMinutes,
      asOf: latestEquityTs,
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  if (latestSnapshot && exposure) {
    metrics.push(
      buildMetric({
        metricName: 'gross_exposure',
        window: params.window,
        unit: 'USD',
        valueNumeric: exposure.grossExposure,
        asOf: latestSnapshot.asOf,
        valueJson: {
          positionCount: exposure.positionCount,
          position_concentration_top1_pct: exposure.top1Pct,
          position_concentration_top5_pct: exposure.top5Pct,
          position_hhi: exposure.hhi,
        },
        nowMs,
        maxStalenessSeconds: params.maxStalenessSeconds,
      }),
    )

    metrics.push(
      buildMetric({
        metricName: 'net_exposure',
        window: params.window,
        unit: 'USD',
        valueNumeric: exposure.netExposure,
        asOf: latestSnapshot.asOf,
        nowMs,
        maxStalenessSeconds: params.maxStalenessSeconds,
      }),
    )

    const leverage = latestSnapshot.equity > 0 ? exposure.grossExposure / latestSnapshot.equity : null
    metrics.push(
      buildMetric({
        metricName: 'leverage_gross_over_equity',
        window: params.window,
        unit: 'ratio',
        valueNumeric: leverage,
        asOf: latestSnapshot.asOf,
        nowMs,
        maxStalenessSeconds: params.maxStalenessSeconds,
      }),
    )

    metrics.push(
      buildMetric({
        metricName: 'position_concentration_top1_pct',
        window: params.window,
        unit: 'ratio',
        valueNumeric: exposure.top1Pct,
        asOf: latestSnapshot.asOf,
        nowMs,
        maxStalenessSeconds: params.maxStalenessSeconds,
      }),
    )

    metrics.push(
      buildMetric({
        metricName: 'position_concentration_top5_pct',
        window: params.window,
        unit: 'ratio',
        valueNumeric: exposure.top5Pct,
        asOf: latestSnapshot.asOf,
        nowMs,
        maxStalenessSeconds: params.maxStalenessSeconds,
      }),
    )

    metrics.push(
      buildMetric({
        metricName: 'position_hhi',
        window: params.window,
        unit: 'ratio',
        valueNumeric: exposure.hhi,
        asOf: latestSnapshot.asOf,
        nowMs,
        maxStalenessSeconds: params.maxStalenessSeconds,
      }),
    )
  } else {
    const missingAsOf = latestEquityTs
    const missingNowMs = nowMs
    const missingMax = params.maxStalenessSeconds
    for (const name of [
      'gross_exposure',
      'net_exposure',
      'leverage_gross_over_equity',
      'position_concentration_top1_pct',
      'position_concentration_top5_pct',
      'position_hhi',
    ]) {
      metrics.push(
        buildMetric({
          metricName: name,
          window: params.window,
          unit: name.includes('exposure') ? 'USD' : 'ratio',
          valueNumeric: null,
          status: 'insufficient_data',
          asOf: missingAsOf,
          nowMs: missingNowMs,
          maxStalenessSeconds: missingMax,
        }),
      )
    }
  }

  metrics.push(
    buildMetric({
      metricName: 'unrealized_pnl',
      window: params.window,
      unit: 'USD',
      valueNumeric: unrealized?.unrealizedPnl ?? null,
      asOf: latestSnapshot?.asOf ?? latestEquityTs,
      valueJson: unrealized ? { positionRows: unrealized.positionRows } : undefined,
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  const netPnl = realized.realizedPnl + (unrealized?.unrealizedPnl ?? 0)
  metrics.push(
    buildMetric({
      metricName: 'net_pnl',
      window: params.window,
      unit: 'USD',
      valueNumeric: unrealized?.unrealizedPnl === null ? null : netPnl,
      asOf: latestSnapshot?.asOf ?? latestExecutionTs,
      nowMs,
      maxStalenessSeconds: params.maxStalenessSeconds,
    }),
  )

  // Placeholder metrics (contract-first) so UI can group and show "insufficient_data" explicitly.
  for (const { name, unit } of [
    { name: 'cost_bps', unit: 'bps' },
    { name: 'sortino_annualized', unit: 'ratio' },
    { name: 'calmar', unit: 'ratio' },
    { name: 'var_95_historical', unit: 'ratio' },
    { name: 'cvar_95_historical', unit: 'ratio' },
    { name: 'fill_ratio', unit: 'ratio' },
    { name: 'reject_rate', unit: 'ratio' },
    { name: 'cancel_rate', unit: 'ratio' },
    { name: 'slippage_bps_vs_mid', unit: 'bps' },
    { name: 'implementation_shortfall_bps', unit: 'bps' },
    { name: 'decision_to_submit_latency_ms_p50', unit: 'ms' },
    { name: 'decision_to_submit_latency_ms_p95', unit: 'ms' },
    { name: 'submit_to_fill_latency_ms_p50', unit: 'ms' },
    { name: 'submit_to_fill_latency_ms_p95', unit: 'ms' },
    { name: 'ta_freshness_seconds', unit: 'seconds' },
    { name: 'context_freshness_seconds', unit: 'seconds' },
    { name: 'metrics_pipeline_lag_seconds', unit: 'seconds' },
  ]) {
    metrics.push(
      buildMetric({
        metricName: name,
        window: params.window,
        unit,
        valueNumeric: null,
        status: 'insufficient_data',
        asOf: now.toISOString(),
        nowMs,
        maxStalenessSeconds: params.maxStalenessSeconds,
      }),
    )
  }

  // Ensure deterministic ordering for stable API diffs.
  metrics.sort((a, b) => a.metricName.localeCompare(b.metricName))

  return {
    strategyId: params.strategy.id,
    account,
    window: params.window,
    frameAsOf: now.toISOString(),
    metrics,
    inputs: {
      executionsCount: filteredExecutions.length,
      equityPoints: equitySeries.length,
      latestExecutionTs,
      latestEquityTs,
      latestSnapshotTs: latestSnapshot?.asOf ?? null,
    },
  }
}
