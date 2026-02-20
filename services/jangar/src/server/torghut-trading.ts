import type { Pool } from 'pg'

import { computeRealizedPnlAverageCostLongOnly, type FilledExecutionForPnl } from '~/server/torghut-trading-pnl'

export type TorghutStrategyRow = {
  id: string
  name: string
  enabled: boolean
  baseTimeframe: string
  universeSymbols: unknown
}

export type TorghutFilledExecutionRow = FilledExecutionForPnl & {
  timeframe: string | null
  alpacaAccountLabel: string | null
  executionExpectedAdapter: string | null
  executionActualAdapter: string | null
  executionFallbackCount: number
}

export type TorghutRejectedDecisionRow = {
  id: string
  createdAt: string
  alpacaAccountLabel: string
  symbol: string
  timeframe: string
  status: string
  rationale: string | null
  riskReasons: string[]
  strategyId: string
  strategyName: string
}

export type TorghutPositionSnapshotPoint = {
  asOf: string
  alpacaAccountLabel: string
  equity: number
  cash: number
  buyingPower: number
}

const parseUuid = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Accept canonical UUIDs only; avoids Postgres casts failing on arbitrary strings.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return null
  return trimmed
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const coerceStringArray = (value: unknown): string[] => {
  if (!value) return []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') return [value]
  return []
}

export const listTorghutTradingStrategies = async (params: { pool: Pool; limit?: number }) => {
  const limit = Math.max(1, Math.min(params.limit ?? 200, 1000))
  const result = await params.pool.query(
    `
      select
        id::text as id,
        name,
        enabled,
        base_timeframe,
        universe_symbols
      from strategies
      order by name asc
      limit $1
    `,
    [limit],
  )

  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    baseTimeframe: String(row.base_timeframe),
    universeSymbols: row.universe_symbols ?? null,
  })) satisfies TorghutStrategyRow[]
}

export const listTorghutTradingFilledExecutions = async (params: {
  pool: Pool
  startUtc: string
  endUtc: string
  strategyId?: string | null
  limit?: number
}) => {
  const limit = Math.max(1, Math.min(params.limit ?? 500, 5000))
  const strategyId = params.strategyId ?? null

  const result = await params.pool.query(
    `
      select
        e.id::text as execution_id,
        e.created_at as execution_created_at,
        e.symbol as symbol,
        e.side as side,
        e.filled_qty as filled_qty,
        e.avg_fill_price as avg_fill_price,
        td.id::text as trade_decision_id,
        td.timeframe as timeframe,
        td.alpaca_account_label as alpaca_account_label,
        e.execution_expected_adapter as execution_expected_adapter,
        e.execution_actual_adapter as execution_actual_adapter,
        e.execution_fallback_count as execution_fallback_count,
        s.id::text as strategy_id,
        s.name as strategy_name
      from executions e
      join trade_decisions td on td.id = e.trade_decision_id
      join strategies s on s.id = td.strategy_id
      where e.status = 'filled'
        and e.created_at >= $1
        and e.created_at < $2
        and ($3::uuid is null or s.id = $3::uuid)
      order by e.created_at asc
      limit $4
    `,
    [params.startUtc, params.endUtc, strategyId, limit],
  )

  return result.rows
    .map((row) => {
      const filledQty = toNumber(row.filled_qty) ?? 0
      const avgFillPrice = toNumber(row.avg_fill_price)
      return {
        executionId: String(row.execution_id),
        tradeDecisionId: row.trade_decision_id ? String(row.trade_decision_id) : null,
        strategyId: String(row.strategy_id),
        strategyName: row.strategy_name ? String(row.strategy_name) : null,
        createdAt: new Date(row.execution_created_at as string | Date).toISOString(),
        symbol: String(row.symbol),
        side: String(row.side),
        filledQty,
        avgFillPrice,
        timeframe: row.timeframe ? String(row.timeframe) : null,
        alpacaAccountLabel: row.alpaca_account_label ? String(row.alpaca_account_label) : null,
        executionExpectedAdapter: row.execution_expected_adapter ? String(row.execution_expected_adapter) : null,
        executionActualAdapter: row.execution_actual_adapter ? String(row.execution_actual_adapter) : null,
        executionFallbackCount: Math.max(0, toNumber(row.execution_fallback_count) ?? 0),
      }
    })
    .filter((row) => row.filledQty > 0 && row.avgFillPrice !== null) satisfies TorghutFilledExecutionRow[]
}

export const listTorghutTradingRejectedDecisions = async (params: {
  pool: Pool
  startUtc: string
  endUtc: string
  strategyId?: string | null
  limit?: number
}) => {
  const limit = Math.max(1, Math.min(params.limit ?? 500, 5000))
  const strategyId = params.strategyId ?? null

  const result = await params.pool.query(
    `
      select
        td.id::text as id,
        td.created_at as created_at,
        td.alpaca_account_label as alpaca_account_label,
        td.symbol as symbol,
        td.timeframe as timeframe,
        td.status as status,
        td.rationale as rationale,
        td.decision_json->'risk_reasons' as risk_reasons,
        s.id::text as strategy_id,
        s.name as strategy_name
      from trade_decisions td
      join strategies s on s.id = td.strategy_id
      where td.status = 'rejected'
        and td.created_at >= $1
        and td.created_at < $2
        and ($3::uuid is null or s.id = $3::uuid)
      order by td.created_at desc
      limit $4
    `,
    [params.startUtc, params.endUtc, strategyId, limit],
  )

  return result.rows.map((row) => ({
    id: String(row.id),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    alpacaAccountLabel: String(row.alpaca_account_label),
    symbol: String(row.symbol),
    timeframe: String(row.timeframe),
    status: String(row.status),
    rationale: row.rationale ? String(row.rationale) : null,
    riskReasons: coerceStringArray(row.risk_reasons),
    strategyId: String(row.strategy_id),
    strategyName: String(row.strategy_name),
  })) satisfies TorghutRejectedDecisionRow[]
}

export const listTorghutTradingPositionSnapshots = async (params: {
  pool: Pool
  startUtc: string
  endUtc: string
  limit?: number
}) => {
  const limit = Math.max(1, Math.min(params.limit ?? 5000, 25_000))

  const result = await params.pool.query(
    `
      select
        as_of,
        alpaca_account_label,
        equity,
        cash,
        buying_power
      from position_snapshots
      where as_of >= $1
        and as_of < $2
      order by as_of asc
      limit $3
    `,
    [params.startUtc, params.endUtc, limit],
  )

  return result.rows
    .map((row) => {
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
      }
    })
    .filter((row): row is TorghutPositionSnapshotPoint => row !== null)
}

export type TorghutTradingSummary = {
  interval: { tz: string; day: string; startUtc: string; endUtc: string }
  strategy: { id: string; name: string } | null
  realizedPnl: {
    value: number
    closedQty: number
    winRate: number | null
    winCount: number
    lossCount: number
    series: { ts: string; realizedPnl: number }[]
    warnings: string[]
  }
  executions: { filledCount: number }
  rejections: {
    rejectedCount: number
    topReasons: { reason: string; count: number }[]
  }
  equity: {
    available: boolean
    byAccount: {
      alpacaAccountLabel: string
      delta: number
      series: { ts: string; equity: number }[]
    }[]
  }
}

export const buildTorghutTradingSummary = async (params: {
  pool: Pool
  interval: { tz: string; day: string; startUtc: string; endUtc: string }
  strategyId?: string | null
}) => {
  const strategyId = params.strategyId ?? null
  const [executions, rejections, strategies, snapshots] = await Promise.all([
    listTorghutTradingFilledExecutions({
      pool: params.pool,
      startUtc: params.interval.startUtc,
      endUtc: params.interval.endUtc,
      strategyId,
      limit: 2000,
    }),
    listTorghutTradingRejectedDecisions({
      pool: params.pool,
      startUtc: params.interval.startUtc,
      endUtc: params.interval.endUtc,
      strategyId,
      limit: 2000,
    }),
    listTorghutTradingStrategies({ pool: params.pool, limit: 500 }),
    listTorghutTradingPositionSnapshots({
      pool: params.pool,
      startUtc: params.interval.startUtc,
      endUtc: params.interval.endUtc,
      limit: 25_000,
    }),
  ])

  const selectedStrategyId = parseUuid(strategyId)
  const selectedStrategyRow = selectedStrategyId
    ? (strategies.find((strategy) => strategy.id.toLowerCase() === selectedStrategyId.toLowerCase()) ?? null)
    : null
  const selectedStrategy =
    selectedStrategyId && selectedStrategyRow ? { id: selectedStrategyId, name: selectedStrategyRow.name } : null

  const pnl = computeRealizedPnlAverageCostLongOnly(executions)

  const reasonsCount = new Map<string, number>()
  for (const decision of rejections) {
    for (const reason of decision.riskReasons) {
      const key = reason.trim()
      if (!key) continue
      reasonsCount.set(key, (reasonsCount.get(key) ?? 0) + 1)
    }
  }
  const topReasons = [...reasonsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([reason, count]) => ({ reason, count }))

  const snapshotsByAccount = new Map<string, TorghutPositionSnapshotPoint[]>()
  for (const snap of snapshots) {
    const key = snap.alpacaAccountLabel
    const list = snapshotsByAccount.get(key) ?? []
    list.push(snap)
    snapshotsByAccount.set(key, list)
  }

  const equityByAccount = [...snapshotsByAccount.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([alpacaAccountLabel, points]) => {
      const first = points[0]
      const last = points[points.length - 1]
      const delta = first && last ? last.equity - first.equity : 0
      return {
        alpacaAccountLabel,
        delta,
        series: points.map((point) => ({ ts: point.asOf, equity: point.equity })),
      }
    })

  return {
    interval: params.interval,
    strategy: selectedStrategy,
    realizedPnl: {
      value: pnl.realizedPnl,
      closedQty: pnl.closedQty,
      winRate: pnl.winRate,
      winCount: pnl.winCount,
      lossCount: pnl.lossCount,
      series: pnl.series,
      warnings: pnl.warnings,
    },
    executions: { filledCount: executions.length },
    rejections: {
      rejectedCount: rejections.length,
      topReasons,
    },
    equity: {
      available: equityByAccount.length > 0,
      byAccount: equityByAccount,
    },
  } satisfies TorghutTradingSummary
}

export const parseTorghutTradingStrategyId = (url: URL) => {
  const strategyId = url.searchParams.get('strategyId')
  if (!strategyId) return { ok: true as const, value: null }
  const parsed = parseUuid(strategyId)
  if (!parsed) return { ok: false as const, message: 'strategyId must be a UUID' }
  return { ok: true as const, value: parsed }
}
