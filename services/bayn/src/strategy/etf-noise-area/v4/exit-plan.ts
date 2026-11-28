import { v4Rules } from './policy'
import { Direction, trueRange, type PriceBar } from './signals'

interface Chandelier {
  readonly direction: Direction
  readonly entry: number
  readonly risk: number
  readonly previousClose: number
  readonly atr: number
  readonly extreme: number
  readonly stop: number
}

export const openChandelier = (direction: Direction, entry: number, atr: number): Chandelier | undefined => {
  const risk = atr * v4Rules.chandelierMultiple
  const stop = entry - direction * risk
  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(risk) ||
    !Number.isFinite(stop) ||
    risk <= 0 ||
    entry <= 0 ||
    stop <= 0
  )
    return
  return { direction, entry, risk, previousClose: entry, atr, extreme: entry, stop }
}

/** An old stop gets first priority. A new ratchet is only eligible on the following bar. */
export const advanceChandelier = (state: Chandelier, bar: PriceBar) => {
  const { direction, entry, risk } = state
  const long = direction === Direction.Long
  if (long ? bar.low <= state.stop : bar.high >= state.stop) return { _tag: 'ExitNextOpen' } as const

  const atr = (state.atr * (v4Rules.atrBars - 1) + trueRange(bar, state.previousClose)) / v4Rules.atrBars
  const extreme = long ? Math.max(state.extreme, bar.high) : Math.min(state.extreme, bar.low)
  const armed = direction * (state.stop - entry) >= 0 || direction * (bar.close - entry) > v4Rules.activationR * risk
  const trailing = extreme - direction * v4Rules.chandelierMultiple * atr
  const stop = armed
    ? long
      ? Math.max(state.stop, entry, trailing)
      : Math.min(state.stop, entry, trailing)
    : state.stop
  return { _tag: 'Hold', state: { ...state, atr, extreme, stop, previousClose: bar.close } } as const
}
