import type { QuantWindow } from './torghut-quant-contract'

const WINDOW_MS: Record<QuantWindow, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '5d': 5 * 24 * 60 * 60_000,
  '20d': 20 * 24 * 60 * 60_000,
}

const windowDurationMs = (window: QuantWindow) => WINDOW_MS[window]

export const computeWindowBoundsUtc = (window: QuantWindow, now = new Date()) => {
  const endMs = now.getTime()
  const startMs = endMs - windowDurationMs(window)
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
  }
}
