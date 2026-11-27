import { intradayAlphaNoiseAreaSymbols } from '../src/strategy/intraday-alpha/constants'
import type { NoiseAreaTrail } from '../src/strategy/intraday-alpha/trailing-exits'
import { horizons, noiseSymbols, type Horizon } from './research-orb-zab-data'

export const capital = 100_000
export const costs = [2, 5, 10] as const
export type Cost = (typeof costs)[number]
export const trainEnd = '2025-06-30'
export const validationEnd = '2026-03-31'
export const fee = 0.21 / 10_000

export interface OrbTrial {
  readonly id: string
  readonly engine: 'orb'
  readonly horizon: Horizon
  readonly rvol: number | null
  readonly rank: 'chase' | 'rvol' | 'top3-rvol'
  readonly cap: 0.25 | null
  readonly collar: 10 | 20 | 30
  readonly exit: 'static' | 'breakeven' | 'vwap' | 'breakeven-vwap'
  readonly hold: 'v2' | '60m' | 'eod'
}

export interface NoiseTrial {
  readonly id: string
  readonly engine: 'noise'
  readonly checkpoint: 15 | 30 | 60
  readonly band: 0.8 | 1 | 1.2
  readonly collar: 10 | 15 | 20 | 25
  readonly exit: 'static' | 'trailing-atr' | NoiseAreaTrail
  readonly universe: 'v2' | 'macro' | (typeof noiseSymbols)[number]
  readonly clock: 'v2' | 'paper'
}

export type Trial = OrbTrial | NoiseTrial
export const v2Orb: OrbTrial = {
  id: 'orb-v2-proxy',
  engine: 'orb',
  horizon: 30,
  rvol: null,
  rank: 'chase',
  cap: null,
  collar: 10,
  exit: 'static',
  hold: 'v2',
}
export const v2Noise: NoiseTrial = {
  id: 'noise-v2-proxy',
  engine: 'noise',
  checkpoint: 60,
  band: 1,
  collar: 10,
  exit: 'static',
  universe: 'v2',
  clock: 'v2',
}

export const noiseUniverse = (trial: NoiseTrial): readonly string[] =>
  trial.universe === 'v2' ? intradayAlphaNoiseAreaSymbols : trial.universe === 'macro' ? noiseSymbols : [trial.universe]

export const orbTrials = () => {
  const trials: OrbTrial[] = [v2Orb]
  const add = (id: string, changes: Partial<Omit<OrbTrial, 'id' | 'engine'>>, base = v2Orb) => {
    trials.push({ ...base, ...changes, id: 'orb-' + id })
  }
  for (const horizon of horizons) {
    if (horizon !== 30) add(`or${horizon}-no-rvol`, { horizon })
    add(`or${horizon}-rank-only`, { horizon, rank: 'rvol' })
    for (const rvol of [1.2, 1.5, 2]) {
      add(`or${horizon}-rvol${rvol}-chase`, { horizon, rvol })
      add(`or${horizon}-rvol${rvol}-rank`, { horizon, rvol, rank: 'rvol' })
      for (const hold of ['v2', 'eod', '60m'] as const) {
        add(`or${horizon}-rvol${rvol}-cap-${hold}`, { horizon, rvol, rank: 'rvol', cap: 0.25, hold })
      }
    }
    const center: OrbTrial = { ...v2Orb, horizon, rvol: 1.5, rank: 'rvol', cap: 0.25 }
    for (const exit of ['breakeven', 'vwap', 'breakeven-vwap'] as const) {
      for (const hold of ['v2', 'eod', '60m'] as const) {
        add(`or${horizon}-center-${exit}-${hold}`, { exit, hold }, center)
      }
    }
    for (const collar of [20, 30] as const) {
      add(`or${horizon}-center-collar${collar}`, { collar }, center)
      add(`or${horizon}-center-collar${collar}-vwap-eod`, { collar, exit: 'vwap', hold: 'eod' }, center)
    }
    add(`or${horizon}-top3-rvol1.5`, { rank: 'top3-rvol', exit: 'vwap', hold: '60m' }, center)
  }
  return trials
}

export const noiseTrials = () => {
  const trials: NoiseTrial[] = [v2Noise]
  const add = (id: string, changes: Partial<Omit<NoiseTrial, 'id' | 'engine'>>, base = v2Noise) => {
    trials.push({ ...base, ...changes, id: 'noise-' + id })
  }
  for (const collar of [15, 20, 25] as const) add(`v2-collar${collar}`, { collar })
  for (const exit of ['vwap', 'opposite-band', 'breakout-band', 'vwap-boundary', 'trailing-atr'] as const) {
    add(`v2-${exit}`, { exit })
  }
  for (const checkpoint of [15, 30, 60] as const) {
    for (const exit of ['static', 'vwap', 'opposite-band', 'trailing-atr'] as const) {
      add(`grid${checkpoint}-${exit}`, { checkpoint, exit, clock: 'paper' })
    }
    for (const band of [0.8, 1, 1.2] as const) {
      for (const collar of [10, 15, 20, 25] as const) {
        add(`grid${checkpoint}-band${band}-collar${collar}`, {
          checkpoint,
          band,
          collar,
          exit: 'vwap-boundary',
          clock: 'paper',
        })
      }
    }
  }
  const center: NoiseTrial = { ...v2Noise, checkpoint: 30, collar: 15, exit: 'vwap-boundary', clock: 'paper' }
  add('all-etfs', { universe: 'macro' }, center)
  for (const symbol of noiseSymbols) add(`only-${symbol}`, { universe: symbol }, center)
  return trials
}

export const isUpgrade = (trial: Trial): boolean =>
  trial.engine === 'orb' ? trial.rvol !== null && trial.rank !== 'chase' : trial.exit !== 'static'

export const neighbors = (trial: Trial, trials: readonly Trial[]): readonly Trial[] => {
  const parameters = Object.entries(trial).filter(([key]) => key !== 'id')
  const axes: Record<string, readonly unknown[]> =
    trial.engine === 'orb'
      ? { rvol: [1.2, 1.5, 2], horizon: horizons, collar: [10, 20, 30] }
      : { checkpoint: [15, 30, 60], band: [0.8, 1, 1.2], collar: [10, 15, 20, 25] }
  return trials.filter((other) => {
    const difference = parameters.filter(([key, value]) => Reflect.get(other, key) !== value)
    if (difference.length !== 1) return false
    const [key, value] = difference[0]
    if (key === 'universe') return true
    const axis = axes[key]
    const next: unknown = Reflect.get(other, key)
    return (
      axis !== undefined &&
      axis.includes(value) &&
      axis.includes(next) &&
      Math.abs(axis.indexOf(value) - axis.indexOf(next)) === 1
    )
  })
}
