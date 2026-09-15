import { resolveTorghutEndpointsConfig } from '~/server/torghut-config'

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

const TORGHUT_API_BASE_URL = resolveTorghutEndpointsConfig(process.env).apiBaseUrl

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
