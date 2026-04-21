import type { Pool } from 'pg'

import { resolveTorghutEndpointsConfig } from '~/server/torghut-config'
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
  rejectReasonAtomic: string[]
  rejectClass: string | null
  rejectOrigin: string | null
  strategyId: string
  strategyName: string
}

export type TorghutDecisionRow = {
  id: string
  createdAt: string
  alpacaAccountLabel: string
  symbol: string
  timeframe: string
  status: string
  rationale: string | null
  submissionBlockReason: string | null
  submissionBlockAtomic: string[]
  submissionStage: string | null
  executionAdapterSelected: boolean
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

type SubmissionFunnel = {
  generatedCount: number
  blockedCount: number
  submittedCount: number
  filledCount: number
  rejectedCount: number
}

type RuntimeProfitabilitySummary = {
  available: boolean
  schemaVersion: string | null
  lookbackHours: number | null
  decisionCount: number
  executionCount: number
  tcaSampleCount: number
  realizedPnlProxyNotional: number | null
  avgAbsSlippageBps: number | null
  caveatCodes: string[]
  error: string | null
}

type RuntimeControlPlaneSummary = {
  available: boolean
  activeRevision: string | null
  capitalStage: string | null
  capitalStageTotals: { stage: string; count: number }[]
  criticalToggleParity: {
    status: string | null
    mismatches: string[]
  }
  error: string | null
}

export type TorghutAutoresearchEpochSummary = {
  epochId: string
  status: string
  targetNetPnlPerDay: string | null
  paperCount: number
  candidateSpecCount: number
  replayedCandidateCount: number
  portfolioCandidateCount: number
  bestPortfolioNetPnlPerDay: string | null
  bestPortfolioActiveDayRatio: string | null
  bestPortfolioPositiveDayRatio: string | null
  blockedPromotionReasons: string[]
  bestPortfolioSleeves: unknown[]
  mlxRankBucketLift: Record<string, unknown>
  falsePositiveTable: Record<string, unknown>[]
  bestFalseNegativeTable: Record<string, unknown>[]
  startedAt: string | null
  completedAt: string | null
  failureReason: string | null
}

export type TorghutAutoresearchEpochsSummary = {
  available: boolean
  count: number
  epochs: TorghutAutoresearchEpochSummary[]
  error: string | null
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

const splitRiskReason = (value: string): string[] =>
  value
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const classifyRejectClass = (decision: TorghutRejectedDecisionRow) => {
  if (decision.rejectClass) return decision.rejectClass
  const reasons =
    decision.rejectReasonAtomic.length > 0 ? decision.rejectReasonAtomic : decision.riskReasons.flatMap(splitRiskReason)
  if (reasons.some((reason) => reason === 'llm_runtime_fallback' || reason === 'llm_error')) return 'runtime'
  if (reasons.some((reason) => reason === 'market_context_block' || reason.startsWith('market_context_'))) {
    return 'market_context'
  }
  if (reasons.some((reason) => reason === 'symbol_capacity_exhausted' || reason === 'qty_below_min')) return 'capacity'
  if (
    reasons.some(
      (reason) =>
        reason === 'shorting_metadata_unavailable' ||
        reason === 'broker_precheck_rejected' ||
        reason === 'sell_inventory_unavailable',
    )
  ) {
    return 'broker_precheck'
  }
  if (
    reasons.some((reason) => reason === 'max_position_pct_exceeded' || reason.startsWith('runtime_uncertainty_gate_'))
  ) {
    return 'policy'
  }
  if (reasons.some((reason) => reason.startsWith('llm_'))) return 'policy'
  return null
}

const decisionReasonTokens = (decision: TorghutRejectedDecisionRow) =>
  decision.rejectReasonAtomic.length > 0 ? decision.rejectReasonAtomic : decision.riskReasons.flatMap(splitRiskReason)

const TORGHUT_API_BASE_URL = resolveTorghutEndpointsConfig(process.env).apiBaseUrl

const SUBMITTED_DECISION_STATUSES = new Set(['submitted', 'filled', 'canceled', 'cancelled', 'expired'])
const SUBMIT_ATTEMPT_DECISION_STAGES = new Set(['submit_requested', 'submitted', 'rejected_submit'])
const STALE_PLANNED_THRESHOLD_MS = 60_000

const countMapToSortedList = (counts: Map<string, number>, limit = 12) =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }))

const toIsoString = (value: Date) => value.toISOString()

const isSubmittedDecisionStatus = (status: string) => SUBMITTED_DECISION_STATUSES.has(status.trim().toLowerCase())

const hasSubmitAttempt = (decision: TorghutDecisionRow) => {
  const submissionStage = decision.submissionStage?.trim().toLowerCase() ?? ''
  if (SUBMIT_ATTEMPT_DECISION_STAGES.has(submissionStage)) return true
  if (isSubmittedDecisionStatus(decision.status)) return true
  return decision.executionAdapterSelected
}

const summarizeDecisionLifecycle = (decisions: TorghutDecisionRow[], staleCutoffIso: string) => {
  const blockedReasonCounts = new Map<string, number>()
  const staleCutoff = Date.parse(staleCutoffIso)
  let plannedCount = 0
  let blockedCount = 0
  let stalePlannedCount = 0
  let executionSubmitAttempts = 0
  let submittedCount = 0

  for (const decision of decisions) {
    const status = decision.status.trim().toLowerCase()
    if (status === 'planned') {
      plannedCount += 1
      const createdAt = Date.parse(decision.createdAt)
      if (Number.isFinite(createdAt) && Number.isFinite(staleCutoff) && createdAt <= staleCutoff) {
        stalePlannedCount += 1
      }
    }
    if (status === 'blocked') {
      blockedCount += 1
      const blockReasons =
        decision.submissionBlockAtomic.length > 0
          ? decision.submissionBlockAtomic
          : decision.submissionBlockReason
            ? [decision.submissionBlockReason]
            : []
      for (const reason of blockReasons) {
        blockedReasonCounts.set(reason, (blockedReasonCounts.get(reason) ?? 0) + 1)
      }
    }
    if (hasSubmitAttempt(decision)) executionSubmitAttempts += 1
    if (isSubmittedDecisionStatus(status)) submittedCount += 1
  }

  return {
    plannedCount,
    blockedCount,
    stalePlannedCount,
    executionSubmitAttempts,
    topBlockedReasons: countMapToSortedList(blockedReasonCounts, 8),
    submissionFunnel: {
      generatedCount: decisions.length,
      blockedCount,
      submittedCount,
      filledCount: 0,
      rejectedCount: decisions.filter((decision) => decision.status.trim().toLowerCase() === 'rejected').length,
    } satisfies SubmissionFunnel,
  }
}

const normalizeCapitalStageTotals = (value: unknown) => {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>)
    .map(([stage, count]) => ({ stage, count: Math.max(0, toNumber(count) ?? 0) }))
    .sort((a, b) => b.count - a.count)
}

const parseRuntimeProfitabilitySummary = (payload: unknown): RuntimeProfitabilitySummary => {
  if (!payload || typeof payload !== 'object') {
    return {
      available: false,
      schemaVersion: null,
      lookbackHours: null,
      decisionCount: 0,
      executionCount: 0,
      tcaSampleCount: 0,
      realizedPnlProxyNotional: null,
      avgAbsSlippageBps: null,
      caveatCodes: [],
      error: 'invalid_profitability_payload',
    }
  }

  const record = payload as Record<string, unknown>
  const windowValue =
    typeof record.window === 'object' && record.window !== null ? (record.window as Record<string, unknown>) : {}
  const realizedSummary =
    typeof record.realized_pnl_summary === 'object' && record.realized_pnl_summary !== null
      ? (record.realized_pnl_summary as Record<string, unknown>)
      : {}
  const caveatCodes = Array.isArray(record.caveats)
    ? record.caveats
        .map((item) =>
          item && typeof item === 'object' && 'code' in item && typeof item.code === 'string' ? item.code : null,
        )
        .filter((item): item is string => item !== null)
    : []

  return {
    available: true,
    schemaVersion: typeof record.schema_version === 'string' ? record.schema_version : null,
    lookbackHours: Math.max(0, toNumber(windowValue.lookback_hours) ?? 0),
    decisionCount: Math.max(0, toNumber(windowValue.decision_count) ?? 0),
    executionCount: Math.max(0, toNumber(windowValue.execution_count) ?? 0),
    tcaSampleCount: Math.max(0, toNumber(windowValue.tca_sample_count) ?? 0),
    realizedPnlProxyNotional: toNumber(realizedSummary.realized_pnl_proxy_notional),
    avgAbsSlippageBps: toNumber(realizedSummary.avg_abs_slippage_bps),
    caveatCodes,
    error: null,
  }
}

const parseRuntimeControlPlaneSummary = (payload: unknown): RuntimeControlPlaneSummary => {
  if (!payload || typeof payload !== 'object') {
    return {
      available: false,
      activeRevision: null,
      capitalStage: null,
      capitalStageTotals: [],
      criticalToggleParity: { status: null, mismatches: [] },
      error: 'invalid_control_plane_payload',
    }
  }

  const record = payload as Record<string, unknown>
  const build =
    typeof record.build === 'object' && record.build !== null ? (record.build as Record<string, unknown>) : {}
  const shadowFirst =
    typeof record.shadow_first === 'object' && record.shadow_first !== null
      ? (record.shadow_first as Record<string, unknown>)
      : {}
  const parity =
    typeof shadowFirst.critical_toggle_parity === 'object' && shadowFirst.critical_toggle_parity !== null
      ? (shadowFirst.critical_toggle_parity as Record<string, unknown>)
      : {}

  return {
    available: true,
    activeRevision:
      typeof build.active_revision === 'string'
        ? build.active_revision
        : typeof shadowFirst.active_revision === 'string'
          ? shadowFirst.active_revision
          : null,
    capitalStage: typeof shadowFirst.capital_stage === 'string' ? shadowFirst.capital_stage : null,
    capitalStageTotals: normalizeCapitalStageTotals(shadowFirst.capital_stage_totals),
    criticalToggleParity: {
      status: typeof parity.status === 'string' ? parity.status : null,
      mismatches: Array.isArray(parity.mismatches)
        ? parity.mismatches.filter((item): item is string => typeof item === 'string')
        : [],
    },
    error: null,
  }
}

const fetchTorghutJson = async (path: string) => {
  const url = `${TORGHUT_API_BASE_URL}${path}`
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      const text = await response.text()
      return { ok: false as const, error: `torghut_request_failed:${response.status}:${text.slice(0, 200)}` }
    }
    return { ok: true as const, payload: (await response.json()) as unknown }
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'torghut_request_failed',
    }
  }
}

const stringOrNull = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null)

const numberOrZero = (value: unknown) => {
  const numeric = toNumber(value)
  return numeric === null ? 0 : Math.max(0, Math.floor(numeric))
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const asRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : []

export const listTorghutAutoresearchEpochs = async (params: {
  status?: string
  limit?: number
}): Promise<TorghutAutoresearchEpochsSummary> => {
  const limit = Math.max(1, Math.min(params.limit ?? 5, 25))
  const query = new URLSearchParams()
  query.set('limit', String(limit))
  if (params.status?.trim()) query.set('status', params.status.trim())
  const response = await fetchTorghutJson(`/trading/autoresearch/epochs?${query.toString()}`)
  if (!response.ok) {
    return {
      available: false,
      count: 0,
      epochs: [],
      error: response.error,
    }
  }

  const payload = asRecord(response.payload)
  const rows = Array.isArray(payload.epochs) ? payload.epochs : []
  const epochs = rows.map((row): TorghutAutoresearchEpochSummary => {
    const item = asRecord(row)
    return {
      epochId: stringOrNull(item.epoch_id) ?? '',
      status: stringOrNull(item.status) ?? 'unknown',
      targetNetPnlPerDay: stringOrNull(item.target_net_pnl_per_day),
      paperCount: numberOrZero(item.paper_count),
      candidateSpecCount: numberOrZero(item.candidate_spec_count),
      replayedCandidateCount: numberOrZero(item.replayed_candidate_count),
      portfolioCandidateCount: numberOrZero(item.portfolio_candidate_count),
      bestPortfolioNetPnlPerDay: stringOrNull(item.best_portfolio_net_pnl_per_day),
      bestPortfolioActiveDayRatio: stringOrNull(item.best_portfolio_active_day_ratio),
      bestPortfolioPositiveDayRatio: stringOrNull(item.best_portfolio_positive_day_ratio),
      blockedPromotionReasons: coerceStringArray(item.blocked_promotion_reasons),
      bestPortfolioSleeves: Array.isArray(item.best_portfolio_sleeves) ? item.best_portfolio_sleeves : [],
      mlxRankBucketLift: asRecord(item.mlx_rank_bucket_lift),
      falsePositiveTable: asRecordArray(item.false_positive_table),
      bestFalseNegativeTable: asRecordArray(item.best_false_negative_table),
      startedAt: stringOrNull(item.started_at),
      completedAt: stringOrNull(item.completed_at),
      failureReason: stringOrNull(item.failure_reason),
    }
  })

  return {
    available: true,
    count: numberOrZero(payload.count) || epochs.length,
    epochs,
    error: null,
  }
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
        td.decision_json->'reject_reason_atomic' as reject_reason_atomic,
        td.decision_json->>'reject_class' as reject_class,
        td.decision_json->>'reject_origin' as reject_origin,
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
    rejectReasonAtomic: coerceStringArray(row.reject_reason_atomic),
    rejectClass: row.reject_class ? String(row.reject_class) : null,
    rejectOrigin: row.reject_origin ? String(row.reject_origin) : null,
    strategyId: String(row.strategy_id),
    strategyName: String(row.strategy_name),
  })) satisfies TorghutRejectedDecisionRow[]
}

export const listTorghutTradingDecisionRows = async (params: {
  pool: Pool
  startUtc: string
  endUtc: string
  strategyId?: string | null
  limit?: number
}) => {
  const limit = Math.max(1, Math.min(params.limit ?? 5_000, 10_000))
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
        td.decision_json->>'submission_block_reason' as submission_block_reason,
        td.decision_json->'submission_block_atomic' as submission_block_atomic,
        td.decision_json->>'submission_stage' as submission_stage,
        case when td.decision_json->'params'->'execution_adapter' is null then false else true end as execution_adapter_selected,
        s.id::text as strategy_id,
        s.name as strategy_name
      from trade_decisions td
      join strategies s on s.id = td.strategy_id
      where td.created_at >= $1
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
    submissionBlockReason: row.submission_block_reason ? String(row.submission_block_reason) : null,
    submissionBlockAtomic: coerceStringArray(row.submission_block_atomic),
    submissionStage: row.submission_stage ? String(row.submission_stage) : null,
    executionAdapterSelected: Boolean(row.execution_adapter_selected),
    strategyId: String(row.strategy_id),
    strategyName: String(row.strategy_name),
  })) satisfies TorghutDecisionRow[]
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
  decisions: {
    generatedCount: number
    plannedCount: number
    blockedCount: number
    stalePlannedCount: number
    executionSubmitAttempts: number
    topBlockedReasons: { reason: string; count: number }[]
    submissionFunnel: SubmissionFunnel
  }
  rejections: {
    rejectedCount: number
    topReasons: { reason: string; count: number }[]
    classCounts: { rejectClass: string; count: number }[]
    sessionSplit: {
      preOpenCount: number
      postOpenCount: number
    }
    perAccountSplit: {
      alpacaAccountLabel: string
      preOpenCount: number
      postOpenCount: number
    }[]
    rolling5DayTrend: {
      windowStartUtc: string
      windowEndUtc: string
      byDay: {
        day: string
        rejectedCount: number
        preOpenCount: number
        postOpenCount: number
        topReasons: { reason: string; count: number }[]
      }[]
    }
  }
  equity: {
    available: boolean
    byAccount: {
      alpacaAccountLabel: string
      delta: number
      series: { ts: string; equity: number }[]
    }[]
  }
  runtime: {
    profitability: RuntimeProfitabilitySummary
    controlPlane: RuntimeControlPlaneSummary
  }
}

const MARKET_OPEN_HOUR = 9
const MARKET_OPEN_MINUTE = 30

type SessionBucket = {
  rejectedCount: number
  preOpenCount: number
  postOpenCount: number
  reasonCounts: Map<string, number>
}

const toMarketParts = (value: string, tz: string) => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const record: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') record[part.type] = part.value
  }

  const year = Number.parseInt(record.year ?? '', 10)
  const month = Number.parseInt(record.month ?? '', 10)
  const day = Number.parseInt(record.day ?? '', 10)
  const hour = Number.parseInt(record.hour ?? '', 10)
  const minute = Number.parseInt(record.minute ?? '', 10)
  if (![year, month, day, hour, minute].every((value) => Number.isFinite(value))) return null

  return {
    year,
    month,
    day,
    hour,
    minute,
    key: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

const classifySessionByMarketTime = (createdAt: string, tz: string): 'pre-open' | 'post-open' => {
  const marketParts = toMarketParts(createdAt, tz)
  if (!marketParts) return 'pre-open'
  if (marketParts.hour > MARKET_OPEN_HOUR) return 'post-open'
  if (marketParts.hour < MARKET_OPEN_HOUR) return 'pre-open'
  return marketParts.minute >= MARKET_OPEN_MINUTE ? 'post-open' : 'pre-open'
}

const formatSessionReasonTop = (bucket: SessionBucket, limit = 12) =>
  [...bucket.reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }))

const addReasonCounts = (bucket: SessionBucket, decision: TorghutRejectedDecisionRow) => {
  for (const key of decisionReasonTokens(decision)) {
    bucket.reasonCounts.set(key, (bucket.reasonCounts.get(key) ?? 0) + 1)
  }
}

const shiftUtcDayWindowStart = (value: string, dayOffset: number) =>
  new Date(Date.parse(value) - dayOffset * 24 * 60 * 60 * 1000).toISOString()

const buildRolling5DayRejectionTrend = (
  decisions: TorghutRejectedDecisionRow[],
  interval: { tz: string; startUtc: string; endUtc: string },
) => {
  const windowStartUtc = shiftUtcDayWindowStart(interval.startUtc, 4)
  const byDay = new Map<string, SessionBucket>()

  for (const decision of decisions) {
    if (decision.createdAt < windowStartUtc || decision.createdAt >= interval.endUtc) continue

    const marketParts = toMarketParts(decision.createdAt, interval.tz)
    if (!marketParts) continue

    const bucket = byDay.get(marketParts.key) ?? {
      rejectedCount: 0,
      preOpenCount: 0,
      postOpenCount: 0,
      reasonCounts: new Map(),
    }
    bucket.rejectedCount += 1
    const session = classifySessionByMarketTime(decision.createdAt, interval.tz)
    if (session === 'pre-open') {
      bucket.preOpenCount += 1
    } else {
      bucket.postOpenCount += 1
    }
    addReasonCounts(bucket, decision)
    byDay.set(marketParts.key, bucket)
  }

  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-5)
    .map(([day, bucket]) => ({
      day,
      rejectedCount: bucket.rejectedCount,
      preOpenCount: bucket.preOpenCount,
      postOpenCount: bucket.postOpenCount,
      topReasons: formatSessionReasonTop(bucket, 6),
    }))

  return {
    windowStartUtc,
    windowEndUtc: interval.endUtc,
    byDay: days,
  }
}

export const buildTorghutTradingSummary = async (params: {
  pool: Pool
  interval: { tz: string; day: string; startUtc: string; endUtc: string }
  strategyId?: string | null
}) => {
  const strategyId = params.strategyId ?? null
  const [
    executions,
    rejections,
    rollingRejections,
    strategies,
    snapshots,
    decisions,
    profitabilityResult,
    controlPlaneResult,
  ] = await Promise.all([
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
    listTorghutTradingRejectedDecisions({
      pool: params.pool,
      startUtc: shiftUtcDayWindowStart(params.interval.startUtc, 4),
      endUtc: params.interval.endUtc,
      strategyId,
      limit: 5000,
    }),
    listTorghutTradingStrategies({ pool: params.pool, limit: 500 }),
    listTorghutTradingPositionSnapshots({
      pool: params.pool,
      startUtc: params.interval.startUtc,
      endUtc: params.interval.endUtc,
      limit: 25_000,
    }),
    listTorghutTradingDecisionRows({
      pool: params.pool,
      startUtc: params.interval.startUtc,
      endUtc: params.interval.endUtc,
      strategyId,
      limit: 5_000,
    }),
    fetchTorghutJson('/trading/profitability/runtime'),
    fetchTorghutJson('/trading/status'),
  ])

  const selectedStrategyId = parseUuid(strategyId)
  const selectedStrategyRow = selectedStrategyId
    ? (strategies.find((strategy) => strategy.id.toLowerCase() === selectedStrategyId.toLowerCase()) ?? null)
    : null
  const selectedStrategy =
    selectedStrategyId && selectedStrategyRow ? { id: selectedStrategyId, name: selectedStrategyRow.name } : null

  const pnl = computeRealizedPnlAverageCostLongOnly(executions)
  const staleReferenceTime = Math.min(Date.parse(params.interval.endUtc), Date.now())
  const staleCutoffIso = toIsoString(
    new Date((Number.isFinite(staleReferenceTime) ? staleReferenceTime : Date.now()) - STALE_PLANNED_THRESHOLD_MS),
  )
  const decisionLifecycle = summarizeDecisionLifecycle(decisions, staleCutoffIso)
  const runtimeProfitability: RuntimeProfitabilitySummary = profitabilityResult.ok
    ? parseRuntimeProfitabilitySummary(profitabilityResult.payload)
    : {
        available: false,
        schemaVersion: null,
        lookbackHours: null,
        decisionCount: 0,
        executionCount: 0,
        tcaSampleCount: 0,
        realizedPnlProxyNotional: null,
        avgAbsSlippageBps: null,
        caveatCodes: [],
        error: profitabilityResult.error,
      }
  const runtimeControlPlane: RuntimeControlPlaneSummary = controlPlaneResult.ok
    ? parseRuntimeControlPlaneSummary(controlPlaneResult.payload)
    : {
        available: false,
        activeRevision: null,
        capitalStage: null,
        capitalStageTotals: [],
        criticalToggleParity: { status: null, mismatches: [] },
        error: controlPlaneResult.error,
      }

  const reasonsCount = new Map<string, number>()
  const classCounts = new Map<string, number>()
  const sessionSplit = {
    preOpenCount: 0,
    postOpenCount: 0,
  }
  const byAccountSplit = new Map<
    string,
    {
      alpacaAccountLabel: string
      preOpenCount: number
      postOpenCount: number
    }
  >()

  for (const decision of rejections) {
    const session = classifySessionByMarketTime(decision.createdAt, params.interval.tz)
    if (session === 'pre-open') sessionSplit.preOpenCount += 1
    else sessionSplit.postOpenCount += 1

    const byAccount = byAccountSplit.get(decision.alpacaAccountLabel) ?? {
      alpacaAccountLabel: decision.alpacaAccountLabel,
      preOpenCount: 0,
      postOpenCount: 0,
    }
    if (session === 'pre-open') byAccount.preOpenCount += 1
    else byAccount.postOpenCount += 1
    byAccountSplit.set(decision.alpacaAccountLabel, byAccount)

    for (const key of decisionReasonTokens(decision)) {
      reasonsCount.set(key, (reasonsCount.get(key) ?? 0) + 1)
    }
    const rejectClass = classifyRejectClass(decision)
    if (rejectClass) classCounts.set(rejectClass, (classCounts.get(rejectClass) ?? 0) + 1)
  }

  const rollingTrend = buildRolling5DayRejectionTrend(rollingRejections, params.interval)
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
    decisions: {
      generatedCount: decisionLifecycle.submissionFunnel.generatedCount,
      plannedCount: decisionLifecycle.plannedCount,
      blockedCount: decisionLifecycle.blockedCount,
      stalePlannedCount: decisionLifecycle.stalePlannedCount,
      executionSubmitAttempts: decisionLifecycle.executionSubmitAttempts,
      topBlockedReasons: decisionLifecycle.topBlockedReasons,
      submissionFunnel: {
        ...decisionLifecycle.submissionFunnel,
        filledCount: executions.length,
        rejectedCount: rejections.length,
      },
    },
    rejections: {
      rejectedCount: rejections.length,
      topReasons,
      classCounts: [...classCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([rejectClass, count]) => ({ rejectClass, count })),
      sessionSplit,
      perAccountSplit: [...byAccountSplit.values()].sort((a, b) =>
        a.alpacaAccountLabel.localeCompare(b.alpacaAccountLabel),
      ),
      rolling5DayTrend: {
        windowStartUtc: rollingTrend.windowStartUtc,
        windowEndUtc: rollingTrend.windowEndUtc,
        byDay: rollingTrend.byDay,
      },
    },
    equity: {
      available: equityByAccount.length > 0,
      byAccount: equityByAccount,
    },
    runtime: {
      profitability: runtimeProfitability,
      controlPlane: runtimeControlPlane,
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

export const __private = {
  splitRiskReason,
  classifyRejectClass,
  classifySessionByMarketTime,
  buildRolling5DayRejectionTrend,
  summarizeDecisionLifecycle,
  parseRuntimeProfitabilitySummary,
  parseRuntimeControlPlaneSummary,
}
