import { advanceChandelier, openChandelier } from '../src/strategy/etf-noise-area/v4/exit-plan'
import { Enhancement, EnhancementSchema, v4Rules } from '../src/strategy/etf-noise-area/v4/policy'
import {
  Direction,
  breadthSymbols,
  confirmsRegime,
  inverseNoiseScale,
  observeCheckpoint,
  type CandidateSymbol,
  type Checkpoint,
} from '../src/strategy/etf-noise-area/v4/signals'

import {
  baskets,
  budgetedShares,
  capital,
  checkpoints,
  closedLeg,
  createReplay,
  markedGrossBound,
  prepare,
} from './noise-area-study-replay'
import type { Day, Ledger, Prepared } from './noise-area-study-replay'
import { base } from './research-10yr-qqq-smh-conditioning'

export const armId = (enhancements: readonly Enhancement[]) => enhancements.join('+') || 'B0'
export const arms = Object.values(EnhancementSchema.enums).reduce<readonly (readonly Enhancement[])[]>(
  (prior, next) => [...prior, ...prior.map((arm) => [...arm, next])],
  [[]],
)

export interface ReplayRow extends Ledger {
  readonly turnover: number
}

type Features = NonNullable<ReturnType<Prepared['bySymbol']['get']>>
type ObservationMap = ReadonlyMap<(typeof breadthSymbols)[number], Checkpoint>
type Frame = {
  readonly slot: number
  readonly observations: ObservationMap
  readonly scales: ReadonlyMap<CandidateSymbol, number>
}
const { barMinutes, volatilityLookbackSessions: lookback } = v4Rules

const bandAt = (f: Features, slot: number) => {
  const move = f.bands[slot]
  if (move === undefined || move <= 0) return
  const width = base.band * move
  return {
    lower: Math.min(f.open, f.previousClose) * (1 - width),
    upper: Math.max(f.open, f.previousClose) * (1 + width),
  }
}

const replayVariant = (day: Prepared, frames: readonly Frame[], arm: readonly Enhancement[]): ReplayRow => {
  const trailing = arm.includes(Enhancement.Trailing)
  const conditional = arm.includes(Enhancement.Regime)
  const sized = arm.includes(Enhancement.Volatility)
  const weight = (symbol: CandidateSymbol) => 1 / (day.bySymbol.get(symbol)?.vol ?? Infinity)
  const totalWeight = weight('QQQ') + weight('SMH')
  const decisionSlots = new Set(frames.map(({ slot }) => slot))
  const flat = day.slots - 15 / barMinutes
  let basePnL = 0
  let slope = 0
  let trades = 0
  let unresolved = 0
  let missingEntries = 0
  let missingHeld = 0
  let grossUpperBound = 0
  let turnover = 0
  for (const symbol of baskets.B0) {
    const f = day.bySymbol.get(symbol)
    const share = weight(symbol)
    if (f === undefined || share === 0) continue
    for (const { slot, observations, scales } of frames) {
      const bar = f.bars[slot]
      const band = bandAt(f, slot)
      if (band === undefined || bar === undefined) continue
      const direction = bar.close > band.upper ? Direction.Long : bar.close < band.lower ? Direction.Short : undefined
      if (
        direction === undefined ||
        (conditional && !confirmsRegime(symbol, direction, (slot + 1) * barMinutes, observations))
      )
        continue
      const budget = (capital * share * (sized ? (scales.get(symbol) ?? 0) : 1)) / totalWeight
      const atr = observations.get(symbol)?.atr
      if (budget <= 0 || (trailing && !(atr !== undefined && atr > 0))) continue
      const entrySlot = slot + 1
      const entry = f.bars[entrySlot]?.open
      if (entry === undefined) {
        missingEntries++
        break
      }
      const quantity = budgetedShares(budget, entry, bar.close)
      if (quantity === 0) break
      let stop = trailing && atr !== undefined ? openChandelier(direction, entry, atr) : undefined
      if (trailing && stop === undefined) break

      let high = entry
      let requested = false
      let exit: number | undefined
      for (let held = entrySlot; held < day.slots; held++) {
        const current = f.bars[held]
        if (current === undefined) {
          missingHeld++
          continue
        }
        if (requested || held >= flat) {
          exit = current.open
          high = Math.max(high, exit)
          break
        }
        high = Math.max(high, current.high)
        if (stop !== undefined) {
          const next = advanceChandelier(stop, current)
          if (next._tag === 'ExitNextOpen') requested = true
          else stop = next.state
        } else {
          const opposing = decisionSlots.has(held) ? bandAt(f, held) : undefined
          requested =
            opposing !== undefined &&
            (direction === Direction.Long ? current.close < opposing.lower : current.close > opposing.upper)
        }
      }
      grossUpperBound += markedGrossBound(quantity, high)
      if (exit === undefined) unresolved++
      else {
        const leg = closedLeg(direction, quantity, entry, exit)
        basePnL += leg.base
        slope += leg.slope
        trades++
        turnover += (quantity * (entry + exit)) / capital
      }
      break // one attempt per symbol and session
    }
  }
  return { base: basePnL, slope, trades, unresolved, missingEntries, missingHeld, grossUpperBound, turnover }
}

export interface SessionReplay {
  readonly date: string
  readonly rows: ReadonlyMap<string, ReplayRow>
}

export const replaySessions = (days: readonly Day[], trials = arms): SessionReplay[] => {
  const history = new Map<string, (number | undefined)[]>()
  return Array.from(prepare(days, baskets.B0), (day, index) => {
    const frames: Frame[] = []
    // Also update history at reached checkpoint clocks when the early-close entry window is already shut.
    const eligible = new Set(checkpoints(day.slots, base.minutes))
    for (let elapsed = base.minutes; elapsed <= Math.min(330, day.slots * barMinutes); elapsed += base.minutes) {
      const slot = elapsed / barMinutes - 1
      const observations = new Map<(typeof breadthSymbols)[number], Checkpoint>()
      const scales = new Map<CandidateSymbol, number>()
      for (const symbol of breadthSymbols) {
        const bars = days[index].bars.get(symbol)
        const f = day.bySymbol.get(symbol)
        const observation =
          bars?.[slot] === undefined ? undefined : observeCheckpoint(bars.slice(0, slot + 1), f?.previousClose)
        if (observation !== undefined) observations.set(symbol, observation)
        if (symbol !== 'QQQ' && symbol !== 'SMH') continue
        const key = `${symbol}/${slot}`
        const prior = history.get(key) ?? []
        if (prior.length === lookback && prior.every((value): value is number => value !== undefined)) {
          const sorted = prior.toSorted((a, b) => a - b)
          const typical = (sorted[Math.floor((lookback - 1) / 2)] + sorted[Math.floor(lookback / 2)]) / 2
          scales.set(symbol, inverseNoiseScale(observation, typical))
        }
        prior.push(observation?.realizedNoise)
        if (prior.length > lookback) prior.shift()
        history.set(key, prior)
      }
      if (eligible.has(slot)) frames.push({ slot, observations, scales })
    }

    let turnover = 0
    const baseline = createReplay(day)(base, baskets.B0, undefined, {
      budget: capital,
      onFill: ({ entry, exit, quantity }) => (turnover += (quantity * (entry + exit)) / capital),
    })
    const rows = new Map<string, ReplayRow>([['B0', { ...baseline, turnover }]])
    for (const arm of trials) {
      if (arm.length > 0) rows.set(armId(arm), replayVariant(day, frames, arm))
    }
    return { date: day.date, rows }
  })
}
