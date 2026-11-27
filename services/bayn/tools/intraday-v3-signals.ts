import { stride, type TapeDay } from './intraday-v3-data'
import { historySessions, noiseSymbols, stocks, type Noise, type Orb, type Reversion } from './intraday-v3-protocol'
import { mean, quantile } from './midday-research-statistics'

export const enum Field {
  Open,
  High,
  Low,
  Close,
  Volume,
  Vwap,
}
export const at = (bars: Float64Array, slot: number, field: Field) => bars[slot * stride + field]
export type Side = 1 | -1
type Stop = { price: number } | { distance: number }
export interface Signal {
  readonly symbol: string
  readonly slot: number
  readonly side: Side
  readonly reference: number
  readonly stop: Stop | null
  readonly target: { riskMultiple: number } | { fraction: number } | null
  readonly exitAt?: (slot: number) => boolean
}
export interface Fill {
  readonly entry: number
  readonly exit: number | null
  readonly exitSlot: number
  readonly exitAtOpen: boolean
  readonly gaps: number
}

export const fillPath = (bars: Float64Array, slots: number, signal: Signal): Fill | 'missing' | null => {
  const start = signal.slot + 1
  const flat = slots - 1
  if (start >= flat) return null
  const entry = at(bars, start, Field.Open)
  if (entry === 0) return 'missing'
  const { side } = signal
  const stop =
    signal.stop === null ? null : 'price' in signal.stop ? signal.stop.price : entry - side * signal.stop.distance
  if (stop !== null && (stop <= 0 || side * (entry - stop) <= 0)) return null
  const target =
    signal.target === null
      ? null
      : entry +
        side *
          ('fraction' in signal.target
            ? entry * signal.target.fraction
            : signal.target.riskMultiple * Math.abs(entry - (stop ?? entry)))
  let gaps = 0
  let pending = false
  for (let slot = start; slot <= flat; slot++) {
    const open = at(bars, slot, Field.Open)
    if (open === 0) {
      gaps++
      continue
    }
    if (slot === flat || pending || (stop !== null && side * (open - stop) <= 0)) {
      return { entry, exit: open, exitSlot: slot, exitAtOpen: true, gaps }
    }
    if (target !== null && side * (open - target) >= 0) {
      return { entry, exit: target, exitSlot: slot, exitAtOpen: true, gaps }
    }
    const adverse = at(bars, slot, side === 1 ? Field.Low : Field.High)
    const favorable = at(bars, slot, side === 1 ? Field.High : Field.Low)
    if (stop !== null && side * (adverse - stop) <= 0) {
      return { entry, exit: stop, exitSlot: slot, exitAtOpen: false, gaps }
    }
    if (target !== null && side * (favorable - target) >= 0) {
      return { entry, exit: target, exitSlot: slot, exitAtOpen: false, gaps }
    }
    pending = signal.exitAt?.(slot) ?? false
  }
  return { entry, exit: null, exitSlot: slots, exitAtOpen: false, gaps }
}

interface Prior {
  readonly close: number
  readonly tr: number
  readonly volume: number
  readonly moves: readonly number[]
}
interface Features {
  readonly prevClose: number
  readonly atr: number
  readonly rvol: number
  readonly moves: readonly number[]
}
interface Rank {
  readonly symbol: string
  readonly bps: number
}
const entrySlots = [23, 29, 35]
const checkpoints = Array.from({ length: 12 }, (_, index) => 6 * index + 5)
const covered = [...stocks, 'SPY', ...noiseSymbols]
const noExclusions = new Set<string>()

export const pickBasket = (
  ranked: readonly Rank[],
  trial: Pick<Reversion, 'gate' | 'minBps'>,
  excluded: ReadonlySet<string> = noExclusions,
) => {
  const eligible = excluded.size === 0 ? ranked : ranked.filter(({ symbol }) => !excluded.has(symbol))
  const [low, secondLow] = eligible
  const [secondHigh, high] = eligible.slice(-2)
  if (eligible.length < 4 || secondLow.bps >= 0 || secondHigh.bps <= 0) return null
  const spread = secondHigh.bps - secondLow.bps
  let dispersion = spread
  if (trial.gate === 'iqr') {
    const bps = eligible.map((row) => row.bps)
    dispersion = (quantile(bps, 0.75) ?? 0) - (quantile(bps, 0.25) ?? 0)
  }
  return dispersion >= trial.minBps ? ([low.symbol, secondLow.symbol, high.symbol, secondHigh.symbol] as const) : null
}

export interface Order {
  readonly symbol: string
  readonly engine: Orb['engine'] | Noise['engine'] | Reversion['engine']
  readonly start: number
  readonly side: Side
  readonly reference: number
  readonly riskDistance: number | null
  readonly fill: ReturnType<typeof fillPath>
}

interface PreparedDay {
  readonly date: string
  readonly orb: (trial: Orb, omitted: string) => readonly Order[]
  readonly reversion: (trial: Reversion, excluded: ReadonlySet<string>) => readonly Order[]
  readonly noise: (trial: Noise, omitted: string) => readonly Order[]
}
export type { PreparedDay }

export const prepareDays = (days: readonly TapeDay[]): readonly PreparedDay[] => {
  const history = new Map<string, (Prior | null)[]>()
  return days.map((day): PreparedDay => {
    const { date, bars, slots } = day
    const features = new Map<string, Features>()
    const deviations = new Map<string, readonly number[]>()
    for (const symbol of covered) {
      const prior = symbol === 'WDC' && date === '2025-02-24' ? [] : (history.get(symbol) ?? [])
      const prevClose = prior.at(-1)?.close ?? 0
      const today = bars.get(symbol)
      let next: Prior | null = null
      if (today !== undefined && at(today, 0, Field.Open) > 0) {
        const first = at(today, 0, Field.Open)
        if (prior.length === historySessions && prior.every((session) => session !== null)) {
          features.set(symbol, {
            prevClose,
            atr: mean(prior.map((session) => session.tr)),
            rvol: at(today, 0, Field.Volume) / mean(prior.map((session) => session.volume)),
            moves: checkpoints.map((_, i) =>
              prior.every((session) => Number.isFinite(session.moves[i]))
                ? mean(prior.map((session) => session.moves[i]))
                : NaN,
            ),
          })
        }
        let dollarVolume = 0
        let volume = 0
        let lo = Infinity
        let hi = 0
        const relative: number[] = []
        let complete = true
        for (let i = 0; i < slots; i++) {
          const shares = at(today, i, Field.Volume)
          if (shares === 0) {
            complete = false
            break
          }
          if (i <= entrySlots[2]) {
            volume += shares
            dollarVolume += shares * at(today, i, Field.Vwap)
            if (entrySlots.includes(i))
              relative.push(10_000 * (at(today, i, Field.Close) / (dollarVolume / volume) - 1))
          }
          lo = Math.min(lo, at(today, i, Field.Low))
          hi = Math.max(hi, at(today, i, Field.High))
        }
        if (features.has(symbol)) deviations.set(symbol, relative)
        if (complete)
          next = {
            close: at(today, slots - 1, Field.Close),
            tr: Math.max(hi, prevClose || first) - Math.min(lo, prevClose || first),
            volume: at(today, 0, Field.Volume),
            // Early-close sessions are complete but later checkpoints did not occur.
            moves: checkpoints.map((slot) => (slot < slots ? Math.abs(at(today, slot, Field.Close) / first - 1) : NaN)),
          }
      }
      prior.push(next)
      if (prior.length > historySessions) prior.shift()
      history.set(symbol, prior)
    }

    const rankedOrb = stocks
      .flatMap((symbol) => {
        const data = bars.get(symbol)
        const feature = features.get(symbol)
        if (!data || !feature || feature.atr <= 0 || feature.rvol < 2) return []
        const first = at(data, 0, Field.Open)
        const close = at(data, 0, Field.Close)
        if (Math.abs(first - feature.prevClose) < 0.5 * feature.atr || first === close) return []
        return [
          { symbol, rvol: feature.rvol, side: first < close ? 1 : -1 } satisfies {
            symbol: string
            rvol: number
            side: Side
          },
        ]
      })
      .sort((a, b) => b.rvol - a.rvol || a.symbol.localeCompare(b.symbol, 'en'))
    const rankedReversion = entrySlots.map((_, index) => {
      const spy = deviations.get('SPY')?.[index]
      if (spy === undefined) return []
      return stocks
        .flatMap((symbol) => {
          const change = deviations.get(symbol)?.[index]
          return change === undefined ? [] : [{ symbol, bps: change - spy }]
        })
        .sort((a, b) => a.bps - b.bps || a.symbol.localeCompare(b.symbol, 'en'))
    })
    const cache = new Map<string, Order | null>()
    const cached = (key: string, build: () => Order | null) => {
      const value = cache.get(key)
      if (value !== undefined) return value
      const next = build()
      cache.set(key, next)
      return next
    }
    const order = (
      engine: Order['engine'],
      symbol: string,
      data: Float64Array,
      signal: Signal,
      riskDistance: number | null,
    ): Order => ({
      engine,
      symbol,
      start: signal.slot + 1,
      side: signal.side,
      reference: signal.reference,
      riskDistance,
      fill: fillPath(data, slots, signal),
    })
    const include = (value: Order | null) => (value === null ? [] : [value])
    return {
      date,
      orb: (trial, omitted) =>
        rankedOrb
          .filter((row) => row.rvol >= trial.rvol && row.symbol !== omitted)
          .slice(0, trial.top)
          .flatMap(({ symbol, side }) =>
            include(
              cached(`orb/${symbol}/${trial.target}`, () => {
                const data = bars.get(symbol)
                if (!data) throw new Error(`Missing ranked OR5 symbol ${symbol}`)
                const edge = at(data, 0, side === 1 ? Field.High : Field.Low)
                const stop = at(data, 0, side === 1 ? Field.Low : Field.High)
                for (let slot = 1; slot < slots - 2; slot++) {
                  if (at(data, slot, Field.Open) === 0) break
                  const touched = at(data, slot, side === 1 ? Field.High : Field.Low)
                  if (side * (touched - edge) <= 0) continue
                  const reference = at(data, slot, Field.Close)
                  const distance = side * (reference - stop)
                  return distance <= 0
                    ? null
                    : order(
                        'orb',
                        symbol,
                        data,
                        {
                          symbol,
                          slot,
                          side,
                          reference,
                          stop: { price: stop },
                          target: trial.target === 'eod' ? null : { riskMultiple: trial.target },
                        },
                        distance,
                      )
                }
                return null
              }),
            ),
          ),
      reversion: (trial, excluded) => {
        const symbols = pickBasket(rankedReversion[entrySlots.indexOf(trial.signalSlot)] ?? [], trial, excluded)
        if (symbols === null) return []
        return symbols.map((symbol, index) => {
          const side = index < 2 ? 1 : -1
          const value = cached(`reversion/${symbol}/${trial.signalSlot}/${side}/${trial.exit}`, () => {
            const data = bars.get(symbol)
            if (!data) throw new Error(`Missing ranked reversion symbol ${symbol}`)
            const reference = at(data, trial.signalSlot, Field.Close)
            return order(
              'reversion',
              symbol,
              data,
              {
                symbol,
                slot: trial.signalSlot,
                side,
                reference,
                stop: trial.exit === 'wide' ? { distance: at(data, trial.signalSlot + 1, Field.Open) * 0.05 } : null,
                target: trial.exit === 'wide' ? { fraction: 0.08 } : null,
              },
              null,
            )
          })
          if (value === null) throw new Error('Non-optional reversion order was not prepared')
          return value
        })
      },
      noise: (trial, omitted) =>
        noiseSymbols
          .filter((symbol) => symbol !== omitted)
          .flatMap((symbol) =>
            include(
              cached(`${trial.id}/${symbol}`, () => {
                const data = bars.get(symbol)
                const feature = features.get(symbol)
                if (!data || !feature || feature.atr <= 0) return null
                const first = at(data, 0, Field.Open)
                const sideAt = (slot: number) => {
                  const move = feature.moves[checkpoints.indexOf(slot)]
                  if (!(move > 0) || at(data, slot, Field.Open) === 0) return 0
                  const close = at(data, slot, Field.Close)
                  return close > Math.max(first, feature.prevClose) * (1 + trial.band * move)
                    ? 1
                    : close < Math.min(first, feature.prevClose) * (1 - trial.band * move)
                      ? -1
                      : 0
                }
                for (const slot of checkpoints) {
                  if (slot >= slots - 2) break
                  const side = sideAt(slot)
                  if (side === 0) continue
                  const signal: Signal = {
                    symbol,
                    slot,
                    side,
                    reference: at(data, slot, Field.Close),
                    stop: trial.exit === 'atr' ? { distance: 1.5 * feature.atr } : null,
                    target: null,
                  }
                  return order(
                    'noise',
                    symbol,
                    data,
                    trial.exit === 'opposite'
                      ? { ...signal, exitAt: (i) => i % 6 === 5 && sideAt(i) === -side }
                      : signal,
                    feature.atr,
                  )
                }
                return null
              }),
            ),
          ),
    }
  })
}
