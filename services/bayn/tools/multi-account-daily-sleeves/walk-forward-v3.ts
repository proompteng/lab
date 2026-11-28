import { withShyCarry, wholeShareCost } from '../../src/strategy/macro-etf-core/planner'
import { asset, emptyWeights, type Etf, parameters, universe } from '../../src/strategy/macro-etf-core/policy'
import { macroRiskRules } from '../../src/strategy/macro-portfolio/risk'
import { requireAlignedSessions } from '../research-lib/calendar'
import { sum } from '../research-lib/statistics'
import { pearson } from '../research-orb-zab-statistics'
import type { DailyFrame } from '../research/macro-etf-core-dual-horizon-data'
import type { DailySession } from '../three-account-capital-core'
import { type Cost, start } from './walk-forward'

export const cashV3Rules = {
  reviewSessions: 42,
  firstO1OpenIndex: 128,
  driftBand: 0.12,
  trendSessions: [63, 126],
  fullTrendAt: 0.03,
  covarianceSessions: 126,
  targetVolatility: 0.07,
  maxO1Weight: 0.5,
  carry: parameters.carry,
  o1Budgets: { SPY: 0.35, GLD: 0.25, IEF: 0.15, DBC: 0.15, UUP: 0.1 },
} as const

type Weights = readonly number[]
type Marks = { readonly date: string; readonly prices: readonly (bigint | undefined)[] }
type Returns = readonly (number | undefined)[]
type Book = { cash: bigint; shares: bigint[]; pendingBuy: Weights | undefined }

const micro = 1_000_000
const bpsScale = 10_000n
const carry = asset[cashV3Rules.carry]
const allCarry = withShyCarry(emptyWeights())
const optional = new Set<Etf>(parameters.optionalCandidates)
const trendBudgets: Readonly<Partial<Record<Etf, number>>> = cashV3Rules.o1Budgets

const marks = (frame: DailyFrame, side: 'open' | 'close'): Marks => ({
  date: frame.date,
  prices: universe.map((symbol) => {
    const price = frame.bars.get(symbol)?.[side]
    if (price === undefined) return undefined
    const micros = Math.round(price * micro)
    if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error(`Invalid ${side} price: ${symbol} ${frame.date}`)
    return BigInt(micros)
  }),
})

const priceAt = (marks: Marks, i: number) => {
  const price = marks.prices[i]
  if (price === undefined) throw new Error(`Missing price: ${universe[i]} ${marks.date}`)
  return price
}

const value = (shares: readonly bigint[], marks: Marks) =>
  shares.reduce((total, qty, i) => total + (qty === 0n ? 0n : qty * priceAt(marks, i)), 0n)

const desiredShares = (weight: number, nav: bigint, marks: Marks, i: number) =>
  weight === 0 ? 0n : BigInt(Math.floor((weight * Number(nav)) / Number(priceAt(marks, i))))

const returnAt = (row: Returns, i: number) => {
  const dailyReturn = row[i]
  if (dailyReturn === undefined) throw new Error(`Incomplete covariance for ${universe[i]}`)
  return dailyReturn
}

const projectedReturn = (weights: Weights, row: Returns) =>
  weights.reduce((total, weight, i) => total + (weight === 0 ? 0 : weight * returnAt(row, i)), 0)

const baseTargets = (frozen: Weights, closes: readonly Marks[]) => {
  const { covarianceSessions, trendSessions, fullTrendAt, maxO1Weight } = cashV3Rules
  const window = closes.slice(-covarianceSessions - 1)
  const current = window.at(-1)
  if (current === undefined || window.length !== covarianceSessions + 1)
    throw new Error('Incomplete cash v3 close history')

  // As in v2, a recently listed F4 candidate stays parked until it has a complete minimum risk window.
  const recent = window.slice(-macroRiskRules.lookback - 1)
  const f4 = withShyCarry(
    frozen.map((weight, i) =>
      optional.has(universe[i]) && recent.some(({ prices }) => prices[i] === undefined) ? 0 : weight,
    ),
  )
  const o1 = universe.map((symbol, i) => {
    const budget = trendBudgets[symbol]
    if (budget === undefined) return 0
    const relative = (row: Marks) => Number(priceAt(row, i)) / Number(priceAt(row, carry))
    const trends = trendSessions.map((horizon) => relative(current) / relative(window[window.length - 1 - horizon]) - 1)
    const conviction = 0.5 + sum(trends) / (2 * trendSessions.length * fullTrendAt)
    return budget * Math.min(1, Math.max(0, conviction))
  })

  const returns = window.slice(1).flatMap((close, t): Returns[] => {
    const before = window[t]
    const row = universe.map((symbol, i) => {
      if (optional.has(symbol) && (close.prices[i] === undefined || before.prices[i] === undefined)) return undefined
      return Number(priceAt(close, i)) / Number(priceAt(before, i)) - 1
    })
    // An optional F4 holding may have the 63-session minimum but not the full 126-session history.
    return f4.some((weight, i) => weight > 0 && row[i] === undefined) ? [] : [row]
  })
  if (returns.length < macroRiskRules.lookback) throw new Error(`Incomplete cash v3 covariance: ${current.date}`)

  const cash = returns.map((row) => returnAt(row, carry))
  const f4Excess = returns.map((row, i) => projectedReturn(f4, row) - cash[i])
  // Discount the fraction of each O1 asset's variance explained by positive F4 co-movement.
  // Restore the original trend budget across the independent exposures, subject to the single-ETF cap.
  const independent = o1.map((weight, i) => {
    if (weight === 0) return 0
    const excess = returns.map((row, t) => returnAt(row, i) - cash[t])
    // With no return dispersion the component has no measured overlap to discount.
    const overlap = Math.max(0, pearson(f4Excess, excess) ?? 0)
    return weight * Math.max(0, 1 - overlap ** 2)
  })
  const independentGross = sum(independent)
  const o1Gross = sum(o1)
  return {
    f4,
    o1: withShyCarry(
      independent.map((weight) =>
        independentGross === 0 ? 0 : Math.min(maxO1Weight, (weight * o1Gross) / independentGross),
      ),
    ),
    returns,
    cash,
    f4Excess,
  }
}

const targetsAtClose = (frozen: Weights, closes: readonly Marks[], f4Share: number) => {
  const { f4, o1, returns, cash, f4Excess } = baseTargets(frozen, closes)
  // Under a zero-mean return forecast, solve E[(SHY + scale * excess)²] <= target².
  // Include SHY's risk and its cross term with the paired ETF baskets.
  let excessVariance = 0
  let twiceCross = 0
  let cashVariance = 0
  for (const [i, row] of returns.entries()) {
    const excess = f4Share * f4Excess[i] + (1 - f4Share) * (projectedReturn(o1, row) - cash[i])
    excessVariance += excess ** 2
    twiceCross += 2 * excess * cash[i]
    cashVariance += cash[i] ** 2
  }
  const budget = (cashV3Rules.targetVolatility ** 2 * returns.length) / macroRiskRules.annualSessions
  const offset = cashVariance - budget
  const scale =
    excessVariance + twiceCross + offset <= 0
      ? 1
      : offset > 0 || excessVariance === 0
        ? 0
        : (-twiceCross + Math.sqrt(twiceCross ** 2 - 4 * excessVariance * offset)) / (2 * excessVariance)
  return [f4, o1].map((weights) => withShyCarry(weights.map((weight) => weight * scale)))
}

const outsideBand = (book: Book, target: Weights, prior: Marks, nav: bigint) => {
  let buys = 0
  let sells = 0
  for (const [i, weight] of target.entries()) {
    const qty = book.shares[i]
    const drift = weight - (qty === 0n ? 0 : Number(qty * priceAt(prior, i)) / Number(nav))
    buys += Math.max(0, drift)
    sells += Math.max(0, -drift)
  }
  return Math.max(buys, sells) >= cashV3Rules.driftBand
}

const sellOverweights = (book: Book, target: Weights, open: Marks, bps: Cost) => {
  const nav = book.cash + value(book.shares, open)
  let traded = 0n
  for (const [i, qty] of book.shares.entries()) {
    if (qty === 0n) continue
    const desired = desiredShares(target[i], nav, open, i)
    if (desired >= qty) continue
    const notional = (qty - desired) * priceAt(open, i)
    book.shares[i] = desired
    book.cash += notional - wholeShareCost(notional, 'sell', bps)
    traded += notional
  }
  book.pendingBuy = target
  return traded
}

const buyUnderweights = (book: Book, target: Weights, open: Marks, bps: Cost) => {
  const nav = book.cash + value(book.shares, open)
  const deficit = book.shares.map((qty, i) => {
    const wanted = desiredShares(target[i], nav, open, i) - qty
    return wanted > 0n ? wanted : 0n
  })
  const notional = value(deficit, open)
  // Reserve for per-order rounding when the settled cash cannot fill all deficits.
  const cost = notional + wholeShareCost(notional, 'buy', bps) + BigInt(deficit.length)
  const available = book.cash < cost ? book.cash : cost
  let traded = 0n
  const buy = (i: number, qty: bigint) => {
    if (qty === 0n) return
    const amount = qty * priceAt(open, i)
    book.shares[i] += qty
    book.cash -= amount + wholeShareCost(amount, 'buy', bps)
    traded += amount
  }
  for (const [i, qty] of deficit.entries()) buy(i, (qty * available) / cost)
  const parkingRoom = desiredShares(target[carry], nav, open, carry) - book.shares[carry]
  if (parkingRoom > 0n) {
    const affordable = (book.cash * bpsScale) / (priceAt(open, carry) * (bpsScale + BigInt(bps)))
    buy(carry, parkingRoom < affordable ? parkingRoom : affordable)
  }
  book.pendingBuy = undefined
  return traded
}

/** Research fills only. A review sells at the next open, then buys at the following open on modeled T+1 cash. */
export const replayCashV3 = (frames: readonly DailyFrame[], frozen: readonly DailySession[], bps: Cost) => {
  requireAlignedSessions(frames, frozen)
  const { firstO1OpenIndex, reviewSessions, covarianceSessions } = cashV3Rules
  const books: Book[] = [start.f4, start.o1].map((usd) => ({
    cash: BigInt(usd * micro),
    shares: universe.map(() => 0n),
    pendingBuy: undefined,
  }))
  const closes: Marks[] = []
  let f4: Weights | undefined
  return frames.map((frame, i) => {
    const prior = closes.at(-1)
    const reviewF4 = frozen[i].f4
    f4 = reviewF4 ?? f4
    const reviews = [
      i > covarianceSessions && reviewF4 !== undefined,
      i >= firstO1OpenIndex && (i - firstO1OpenIndex) % reviewSessions === 0,
    ]
    let targets: (Weights | undefined)[] = []
    if (prior !== undefined && reviews.some(Boolean)) {
      if (f4 === undefined) throw new Error(`Missing frozen F4 signal before cash v3 review: ${frame.date}`)
      const nav = books.map((book) => book.cash + value(book.shares, prior))
      const proposed = targetsAtClose(f4, closes, Number(nav[0]) / Number(nav[0] + nav[1]))
      targets = proposed.map((target, j) =>
        reviews[j] && outsideBand(books[j], target, prior, nav[j]) ? target : undefined,
      )
    }

    const open = marks(frame, 'open')
    let traded = 0n
    let openingGross = 0
    for (const [j, book] of books.entries()) {
      const target = targets[j]
      const purchase = i === 0 ? allCarry : book.pendingBuy
      if (purchase !== undefined) traded += buyUnderweights(book, purchase, open, bps)
      else if (target !== undefined) traded += sellOverweights(book, target, open, bps)
      const gross = value(book.shares, open)
      if (book.cash < 0n || book.cash + gross <= 0n) throw new Error(`Unfunded cash v3 open: ${frame.date}`)
      openingGross = Math.max(openingGross, Number(gross) / Number(book.cash + gross))
    }
    const close = marks(frame, 'close')
    closes.push(close)
    const nav = books.map((book) => Number(book.cash + value(book.shares, close)) / micro)
    return { date: frame.date, f4: nav[0], o1: nav[1], tradedUsd: Number(traded) / micro, openingGross }
  })
}
