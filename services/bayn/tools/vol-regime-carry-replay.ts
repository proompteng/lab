import { type Session, type Symbol, assets, universe } from './vol-regime-carry-data'
import { band, weights } from './vol-regime-carry-signals'

export type Book = { net: number; turnover: number; fees: number }
export type Day = { date: string; shy: number; spy: number; zero: Book; idle: Book }
type Targets = readonly (number[] | undefined)[]
type State = { shares: number[]; cash: number; equity: number }

const initial = (): State => ({ shares: weights(), cash: 1, equity: 1 })
const sellFee = 0.21 / 10_000

export const idleTarget = (target: number[], omit?: Symbol) => {
  if (omit === 'SHY') return target
  const invested = target.reduce((sum, weight) => sum + weight, 0)
  return target.map((weight, i) => weight + (i === assets.SHY ? Math.max(0, 1 - invested) : 0))
}

export const shouldTrade = (current: number[], target: number[]) => {
  let buys = 0
  let sells = 0
  for (let i = 0; i < current.length; i++) {
    const delta = target[i] - current[i]
    if (delta > 0) buys += delta
    else sells -= delta
  }
  return Math.max(buys, sells) >= band
}

export const openingTrade = (current: number[], nav: number, target: number[], roundTripBps: number) => {
  const investedWeight = target.reduce((sum, weight) => sum + weight, 0)
  if (investedWeight > 1 + 1e-12 || target.some((weight) => !Number.isFinite(weight) || weight < 0))
    throw new Error('Invalid fully funded long-only allocation')
  const slip = roundTripBps / 20_000
  let post = nav
  // Solve post + execution costs(post) = NAV; the fee function has slope bounded by the max fee rate.
  const notionals = (equity: number) =>
    target.reduce(
      ([buys, sells], weight, i) => {
        const delta = weight * equity - current[i]
        return delta >= 0 ? [buys + delta, sells] : [buys, sells - delta]
      },
      [0, 0],
    )
  for (let i = 0; i < 6; i++) {
    const [buys, sells] = notionals(post)
    post = nav - buys * slip - sells * (slip + sellFee)
  }
  const [buys, sells] = notionals(post)
  return {
    invested: target.map((weight) => post * weight),
    cash: post * Math.max(0, 1 - investedWeight),
    fees: (nav - post) / nav,
    turnover: (buys + sells) / (2 * nav),
  }
}

export const replay = (
  sessions: readonly Session[],
  targets: Targets,
  roundTripBps: number,
  omitted?: Symbol,
  held?: Set<Symbol>,
): Day[] => {
  const zero = initial()
  const idle = initial()
  const cashTarget = weights()
  const sweep = idleTarget(cashTarget, omitted)
  return sessions.map(({ bars, date }, i) => {
    const advance = (state: State, target: number[] | undefined): Book => {
      let turnover = 0
      let fees = 0
      if (target !== undefined) {
        const current = state.shares.map((shares, j) => {
          if (shares === 0) return 0
          const bar = bars[j]
          if (bar === undefined) throw new Error(`Missing opening mark for ${universe[j]} on ${date}`)
          return shares * bar.open
        })
        const nav = current.reduce((sum, value) => sum + value, state.cash)
        const trade = openingTrade(current, nav, target, roundTripBps)
        state.shares = trade.invested.map((value, j) => {
          if (value === 0) return 0
          const bar = bars[j]
          if (bar === undefined || universe[j] === omitted)
            throw new Error(`Unavailable or omitted execution: ${universe[j]} ${date}`)
          held?.add(universe[j])
          return value / bar.open
        })
        state.cash = trade.cash
        turnover = trade.turnover
        fees = trade.fees
      }
      const closing = state.shares.reduce((sum, shares, j) => {
        if (shares === 0) return sum
        const bar = bars[j]
        if (bar === undefined) throw new Error(`Missing closing mark for ${universe[j]} on ${date}`)
        return sum + shares * bar.close
      }, state.cash)
      const net = closing / state.equity - 1
      state.equity = closing
      return { net, turnover, fees }
    }
    const benchmark = (symbol: 'SPY' | 'SHY') => {
      const idx = assets[symbol]
      const bar = bars[idx]
      const previous = i === 0 ? bar?.open : sessions[i - 1].bars[idx]?.close
      if (bar === undefined || previous === undefined) throw new Error(`Missing benchmark mark: ${symbol} ${date}`)
      return bar.close / previous - 1
    }
    const signal = i === 0 ? undefined : targets[i - 1]
    const allocation = (state: State, target: number[]) => {
      const priorWeights = state.shares.map((shares, j) => {
        if (shares === 0) return 0
        const bar = sessions[i - 1].bars[j]
        if (bar === undefined) throw new Error(`Missing prior close for ${universe[j]} on ${date}`)
        return (shares * bar.close) / state.equity
      })
      return shouldTrade(priorWeights, target) ? target : undefined
    }
    return {
      date,
      shy: benchmark('SHY'),
      spy: benchmark('SPY'),
      zero: advance(zero, signal === undefined ? undefined : allocation(zero, signal)),
      idle: advance(
        idle,
        i === 0 ? sweep : signal === undefined ? undefined : allocation(idle, idleTarget(signal, omitted)),
      ),
    }
  })
}
