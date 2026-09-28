export type StrategyItem = {
  id: string
  name: string
  enabled: boolean
  baseTimeframe: string
  universeSymbols: unknown
}

export type Interval = {
  tz: string
  day: string
  startUtc: string
  endUtc: string
}

export type TradingSummary = {
  interval: Interval
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
    submissionFunnel: {
      generatedCount: number
      blockedCount: number
      submittedCount: number
      filledCount: number
      rejectedCount: number
    }
  }
  rejections: {
    rejectedCount: number
    topReasons: { reason: string; count: number }[]
  }
  equity: {
    available: boolean
    byAccount: { alpacaAccountLabel: string; delta: number; series: { ts: string; equity: number }[] }[]
  }
  runtime: {
    profitability: {
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
    controlPlane: {
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
  }
}

export type FilledExecution = {
  executionId: string
  tradeDecisionId: string | null
  strategyId: string
  strategyName: string | null
  createdAt: string
  symbol: string
  side: string
  filledQty: number
  avgFillPrice: number | null
  timeframe: string | null
  alpacaAccountLabel: string | null
}

export type RejectedDecision = {
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

export type TorghutTradingPageData = {
  strategies: StrategyItem[]
  strategiesError: string | null
  selectedStrategyId: string
  summary: TradingSummary | null
  summaryError: string | null
  executions: FilledExecution[]
  decisions: RejectedDecision[]
  disabledMessage: string | null
}

export const DEFAULT_TZ = 'America/New_York'

const getErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { message?: unknown; error?: unknown }
  if (typeof record.message === 'string' && record.message) return record.message
  if (typeof record.error === 'string' && record.error) return record.error
  return null
}

const isStrategiesPayload = (value: unknown): value is { ok: true; items: StrategyItem[] } => {
  if (!value || typeof value !== 'object') return false
  if (!('ok' in value) || !('items' in value)) return false
  if ((value as { ok?: unknown }).ok !== true) return false
  return Array.isArray((value as { items?: unknown }).items)
}

const isSummaryPayload = (value: unknown): value is { ok: true; summary: TradingSummary } => {
  if (!value || typeof value !== 'object') return false
  if (!('ok' in value) || !('summary' in value)) return false
  return (value as { ok?: unknown }).ok === true
}

const isItemsPayload = <T>(value: unknown): value is { ok: true; items: T[] } => {
  if (!value || typeof value !== 'object') return false
  if (!('items' in value)) return false
  return Array.isArray((value as { items?: unknown }).items)
}

export const fetchTradingStrategies = async () => {
  const response = await fetch('/api/torghut/trading/strategies')
  const payload = (await response.json().catch(() => null)) as unknown

  if (!response.ok) {
    const error = getErrorMessage(payload) ?? `Failed to load strategies (${response.status})`
    const disabled = Boolean(payload && typeof payload === 'object' && 'disabled' in payload)
    return { ok: false as const, error, disabled }
  }

  if (!isStrategiesPayload(payload)) {
    return { ok: false as const, error: 'Unexpected strategies payload.', disabled: false }
  }

  const items = payload.items.filter(
    (item): item is StrategyItem => Boolean(item) && typeof item.id === 'string' && typeof item.name === 'string',
  )

  return { ok: true as const, items }
}

export const fetchTradingSnapshot = async (params: { day: string; strategyId: string; signal?: AbortSignal }) => {
  const query = new URLSearchParams({ day: params.day, tz: DEFAULT_TZ })
  if (params.strategyId) {
    query.set('strategyId', params.strategyId)
  }

  const [summaryRes, execRes, decRes] = await Promise.all([
    fetch(`/api/torghut/trading/summary?${query}`, { signal: params.signal }),
    fetch(`/api/torghut/trading/executions?${query}`, { signal: params.signal }),
    fetch(`/api/torghut/trading/decisions?${query}`, { signal: params.signal }),
  ])

  const summaryPayload = (await summaryRes.json().catch(() => null)) as unknown
  if (!summaryRes.ok) {
    const error = getErrorMessage(summaryPayload) ?? `Failed to load summary (${summaryRes.status})`
    const disabled = Boolean(summaryPayload && typeof summaryPayload === 'object' && 'disabled' in summaryPayload)
    return {
      ok: false as const,
      error,
      disabledMessage: disabled ? error : null,
      summary: null,
      executions: [],
      decisions: [],
    }
  }

  if (!isSummaryPayload(summaryPayload)) {
    return {
      ok: false as const,
      error: 'Unexpected summary payload.',
      disabledMessage: null,
      summary: null,
      executions: [],
      decisions: [],
    }
  }

  const execPayload = (await execRes.json().catch(() => null)) as unknown
  const decPayload = (await decRes.json().catch(() => null)) as unknown

  return {
    ok: true as const,
    summary: summaryPayload.summary,
    executions: execRes.ok && isItemsPayload<FilledExecution>(execPayload) ? execPayload.items : [],
    decisions: decRes.ok && isItemsPayload<RejectedDecision>(decPayload) ? decPayload.items : [],
    disabledMessage: null,
  }
}

export const loadTorghutTradingPageData = async (day: string): Promise<TorghutTradingPageData> => {
  const strategiesResult = await fetchTradingStrategies()
  if (!strategiesResult.ok) {
    return {
      strategies: [],
      strategiesError: strategiesResult.error,
      selectedStrategyId: '',
      summary: null,
      summaryError: strategiesResult.disabled ? null : strategiesResult.error,
      executions: [],
      decisions: [],
      disabledMessage: strategiesResult.disabled ? strategiesResult.error : null,
    }
  }

  const selectedStrategyId = strategiesResult.items[0]?.id ?? ''
  if (!selectedStrategyId) {
    return {
      strategies: strategiesResult.items,
      strategiesError: null,
      selectedStrategyId: '',
      summary: null,
      summaryError: null,
      executions: [],
      decisions: [],
      disabledMessage: null,
    }
  }

  const snapshot = await fetchTradingSnapshot({ day, strategyId: selectedStrategyId })
  if (!snapshot.ok) {
    return {
      strategies: strategiesResult.items,
      strategiesError: null,
      selectedStrategyId,
      summary: null,
      summaryError: snapshot.error,
      executions: [],
      decisions: [],
      disabledMessage: snapshot.disabledMessage,
    }
  }

  return {
    strategies: strategiesResult.items,
    strategiesError: null,
    selectedStrategyId,
    summary: snapshot.summary,
    summaryError: null,
    executions: snapshot.executions,
    decisions: snapshot.decisions,
    disabledMessage: snapshot.disabledMessage,
  }
}
