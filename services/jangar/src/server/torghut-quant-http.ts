import { isQuantWindow, type QuantWindow } from './torghut-quant-contract'

const parseUuid = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return null
  return trimmed
}

export const parseQuantStrategyId = (url: URL) => {
  const raw = url.searchParams.get('strategy_id') ?? url.searchParams.get('strategyId')
  const parsed = parseUuid(raw)
  if (!parsed) return { ok: false as const, message: 'strategy_id must be a UUID' }
  return { ok: true as const, value: parsed }
}

export const parseQuantAccount = (url: URL) => {
  const raw = url.searchParams.get('account') ?? ''
  const value = raw.trim()
  return { ok: true as const, value }
}

export const parseQuantWindow = (url: URL) => {
  const raw = url.searchParams.get('window')
  if (!raw) return { ok: false as const, message: 'Missing required query param: window' }
  const trimmed = raw.trim()
  if (!isQuantWindow(trimmed)) {
    return { ok: false as const, message: `window must be one of: 1m, 5m, 15m, 1h, 1d, 5d, 20d` }
  }
  return { ok: true as const, value: trimmed as QuantWindow }
}

export const parseIsoUtc = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

export const parseMetricList = (raw: string | null) =>
  (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
