import { rebalanceDue, wholeShareCost, withShyCarry } from '../src/strategy/macro-etf-core/planner'
import { asset, type Etf, universe } from '../src/strategy/macro-etf-core/policy'
import { cap as intradayCapUsd, closedLeg } from './noise-area-study-replay'
import { elapsedDays, requireAlignedSessions } from './research-lib/calendar'
import { calmar, maxDrawdown, mean, sharpe, sortino, sum } from './research-lib/statistics'
import { costs } from './research/macro-etf-core-dual-horizon-account'
import { o1Band } from './research/macro-etf-core-wave5d'

export enum IntradayVariant {
  B0 = 'B0',
  Phase2 = 'Phase2',
}

export enum IntradayMode {
  SettledCashLongOnly = 'SettledCashLongOnly',
  UnleveredLongShort = 'UnleveredLongShort',
}

export enum ShareSizing {
  Whole = 'Whole',
  Fractional = 'Fractional',
}

const capitalTiers = [
  { intraday: 10_000, f4: 10_000, o1: 10_000, mode: IntradayMode.SettledCashLongOnly },
  { intraday: 30_000, f4: 10_000, o1: 10_000, mode: IntradayMode.UnleveredLongShort },
  { intraday: 40_000, f4: 35_000, o1: 25_000, mode: IntradayMode.UnleveredLongShort },
  { intraday: 100_000, f4: 90_000, o1: 60_000, mode: IntradayMode.UnleveredLongShort },
] as const

export interface IntradayLeg {
  readonly weight: number
  readonly side: 1 | -1
  readonly entry: number
  readonly reference: number
  readonly exit: number
  readonly missingHeld: number
}

export interface IntradaySession {
  readonly date: string
  readonly legs: readonly IntradayLeg[]
}

interface Mark {
  readonly open: number
  readonly close: number
}

export interface DailySession {
  readonly date: string
  readonly bars: ReadonlyMap<Etf, Mark>
  // Both review vectors are keyed by execution date, not signal date.
  readonly f4: readonly number[] | undefined
  readonly o1: readonly number[] | undefined
}

export interface CapitalTape {
  readonly daily: readonly DailySession[]
  readonly intraday: Readonly<Record<IntradayVariant, readonly IntradaySession[]>>
}

const annualization = Math.sqrt(252)
const dailySizingCapUsd = 150_000
const legacyPdtFloorUsd = 25_000
const costsPerSide = Math.max(...costs)
const roundOffUsd = 0.000_001
const usdMicros = (usd: number) => BigInt(Math.round(usd * 1_000_000))
const shares = (ideal: number, sizing: ShareSizing) => (sizing === ShareSizing.Whole ? Math.floor(ideal) : ideal)

// Account #1 starts and ends flat. All entry budgets come from start-of-session equity;
// no symbol can reuse same-day proceeds or inherit a withheld symbol's allocation.
export const tradeIntraday = (
  session: IntradaySession,
  equityUsd: number,
  mode: IntradayMode,
  sizing: ShareSizing,
  oneWayBps: number,
) => {
  const budget = Math.min(equityUsd, intradayCapUsd)
  let pnl = 0
  let fills = 0
  let withheldShorts = 0
  let heldGaps = 0
  for (const leg of session.legs) {
    if (leg.side === -1 && mode === IntradayMode.SettledCashLongOnly) {
      withheldShorts++
      continue
    }
    const reservePrice = Math.max(leg.reference, leg.entry * (1 + costsPerSide / 10_000))
    const qty = shares((budget * leg.weight) / reservePrice, sizing)
    if (qty === 0) continue
    // Wave 9B's closed-leg slope is per round-trip bp, not per-side bp.
    const net = closedLeg(leg.side, qty, leg.entry, leg.exit)
    pnl += net.base - 2 * oneWayBps * net.slope
    fills++
    heldGaps += leg.missingHeld
  }
  return { pnl, fills, withheldShorts, heldGaps }
}

const mark = (session: DailySession, i: number, at: 'open' | 'close') => {
  const price = session.bars.get(universe[i])?.[at]
  if (price === undefined || !Number.isFinite(price) || price <= 0)
    throw new Error(`Missing or invalid ${at} price: ${universe[i]} ${session.date}`)
  return Number(usdMicros(price)) / 1_000_000
}

const valuesAt = (quantities: readonly number[], session: DailySession, at: 'open' | 'close') =>
  quantities.map((qty, i) => (qty === 0 ? 0 : qty * mark(session, i, at)))

const netBook = (book: { strategy: readonly number[]; carry: number }) =>
  book.strategy.map((qty, i) => (i === asset.SHY ? qty + book.carry : qty))

const positiveEquity = (equity: number, date: string) => {
  if (!Number.isFinite(equity) || equity <= 0) throw new Error(`Invalid closing equity on ${date}`)
  return equity
}

const annualizedDeviation = (net: readonly number[]) => {
  if (net.length < 2 || net.every((r) => r === net[0])) return 0
  const center = mean(net)
  return Math.sqrt(sum(net.map((r) => (r - center) ** 2)) / (net.length - 1)) * annualization
}

const replayDaily = (
  daily: readonly DailySession[],
  initialUsd: number,
  sleeve: 'f4' | 'o1',
  sizing: ShareSizing,
  oneWayBps: (typeof costs)[number],
) => {
  let equity = initialUsd
  let cash = initialUsd
  let book = { strategy: universe.map(() => 0), carry: 0 }
  let priorClose = book.strategy

  return daily.map((session, i) => {
    const { date } = session
    const signal = session[sleeve]
    const weights = signal !== undefined && sleeve === 'f4' ? withShyCarry(signal) : signal
    const changed =
      sleeve === 'o1' ? weights?.map((weight, j) => Math.abs(weight - priorClose[j] / equity) >= o1Band) : undefined
    const review =
      weights !== undefined &&
      (sleeve === 'f4'
        ? rebalanceDue(
            weights.map((weight, j) => ({ weight, priorMicros: usdMicros(priorClose[j]) })),
            usdMicros(equity),
          )
        : changed?.some(Boolean) === true)

    if (i === 0 || (review && weights !== undefined)) {
      const before = netBook(book)
      const openEquity = cash + sum(valuesAt(before, session, 'open'))
      const kept = book.strategy.map((qty, j) => (sleeve === 'o1' && changed?.[j] !== true ? qty : 0))
      const keptGross = sum(valuesAt(kept, session, 'open'))
      const planned = weights?.map((weight, j) => (sleeve === 'f4' || changed?.[j] === true ? weight : 0))
      const plannedWeight = planned === undefined ? 0 : sum(planned)
      let budget = Math.min(openEquity, dailySizingCapUsd)
      let settled = false
      // Size on post-fee opening equity as in Wave 8A. Lowering the budget (never
      // increasing it) also handles share boundaries where there is no exact fixed point.
      for (let attempt = 0; attempt < 16; attempt++) {
        const remaining = Math.max(0, budget - keptGross)
        const scale = plannedWeight === 0 ? 0 : Math.min(budget, remaining / plannedWeight)
        const strategy = kept.map((qty, j) => {
          const target = (planned?.[j] ?? 0) * scale
          return target === 0 ? qty : shares(target / mark(session, j, 'open'), sizing)
        })
        let carry = 0
        if (sleeve === 'o1' || planned === undefined) {
          const residual = Math.max(0, budget - sum(valuesAt(strategy, session, 'open')))
          carry = shares(residual / mark(session, asset.SHY, 'open'), sizing)
          if (sleeve === 'f4') {
            strategy[asset.SHY] = carry
            carry = 0
          }
        }
        const next = { strategy, carry }
        const after = netBook(next)
        const fees = sum(
          after.map((qty, j) => {
            const delta = qty - before[j]
            if (delta === 0) return 0
            const notional = usdMicros(Math.abs(delta) * mark(session, j, 'open'))
            return Number(wholeShareCost(notional, delta > 0 ? 'buy' : 'sell', oneWayBps)) / 1_000_000
          }),
        )
        const postFees = openEquity - fees
        const nextCash = postFees - sum(valuesAt(after, session, 'open'))
        if (nextCash >= -roundOffUsd && budget <= postFees + roundOffUsd) {
          book = next
          cash = Math.max(0, nextCash)
          settled = true
          break
        }
        budget = Math.min(budget - roundOffUsd, postFees)
      }
      if (!settled) throw new Error(`Unable to fund ${sleeve.toUpperCase()} next-open rebalance: ${date}`)
    }
    priorClose = valuesAt(book.strategy, session, 'close')
    equity = positiveEquity(
      cash + sum(priorClose) + (book.carry === 0 ? 0 : book.carry * mark(session, asset.SHY, 'close')),
      date,
    )
    return equity
  })
}

const returns = (equities: readonly number[], startingUsd: number) =>
  equities.map((eq, i) => eq / (equities[i - 1] ?? startingUsd) - 1)

const metrics = (equities: readonly number[], net: readonly number[], startingUsd: number, years: number) => {
  const endingEquityUsd = equities[equities.length - 1]
  const cagr = (endingEquityUsd / startingUsd) ** (1 / years) - 1
  const drawdown = maxDrawdown(net, true)
  return {
    endingEquityUsd,
    cagr,
    annualizedVolatility: annualizedDeviation(net),
    sharpe: sharpe(net),
    sortino: sortino(net),
    maxDrawdown: drawdown,
    calmar: calmar(cagr, drawdown),
  }
}

const correlationOrder = ['intraday', 'f4', 'o1'] as const
const correlations = (net: Record<(typeof correlationOrder)[number], readonly number[]>) => {
  const centered = correlationOrder.map((account) => {
    const daily = net[account]
    const center = daily.every((r) => r === daily[0]) ? daily[0] : mean(daily)
    return daily.map((r) => r - center)
  })
  const variance = centered.map((daily) => sum(daily.map((r) => r ** 2)))
  return {
    order: correlationOrder,
    matrix: centered.map((a, i) =>
      centered.map((b, j) => {
        const denom = Math.sqrt(variance[i] * variance[j])
        return denom > 0 ? sum(a.map((r, k) => r * b[k])) / denom : null
      }),
    ),
  }
}

export const assessPdtBuffer = (startingUsd: number, closes: readonly number[], drawdown: number) => {
  const retention = 1 - drawdown
  const minimumCents = Math.floor((legacyPdtFloorUsd * 100) / retention) + 1
  const stressedEquityUsd = startingUsd * retention
  return {
    legacyFloorUsd: legacyPdtFloorUsd,
    minimumStartingEquityUsd:
      (minimumCents / 100) * retention > legacyPdtFloorUsd ? minimumCents / 100 : (minimumCents + 1) / 100,
    stressedEquityUsd,
    clearsDrawdownStress: stressedEquityUsd > legacyPdtFloorUsd,
    lowestHistoricalEquityUsd: closes.reduce((minimum, eq) => Math.min(minimum, eq), startingUsd),
    sessionsAtOrBelowFloor: closes.filter((eq) => eq <= legacyPdtFloorUsd).length,
  }
}

const compare = (
  whole: ReturnType<typeof metrics>,
  frac: ReturnType<typeof metrics>,
  a: readonly number[],
  b: readonly number[],
) => ({
  cagrDeltaBps: (whole.cagr - frac.cagr) * 10_000,
  endingEquityDeltaUsd: whole.endingEquityUsd - frac.endingEquityUsd,
  trackingErrorBps: annualizedDeviation(a.map((r, i) => r - b[i])) * 10_000,
})

export const studyCapitalAllocation = ({ daily, intraday }: CapitalTape) => {
  requireAlignedSessions(daily, intraday[IntradayVariant.B0], intraday[IntradayVariant.Phase2])
  const from = daily[0]?.date
  const through = daily.at(-1)?.date
  if (from === undefined || through === undefined || daily.length < 2) throw new Error('Expected at least two sessions')
  const years = (elapsedDays(from, through) + 1) / 365.2425
  if (!(years > 0)) throw new Error('Invalid session span')

  return {
    window: { from, through, sessions: daily.length, years },
    scenarios: capitalTiers.flatMap((allocation) => {
      const tier = { ...allocation, totalUsd: allocation.intraday + allocation.f4 + allocation.o1 }
      return costs.flatMap((oneWayBps) => {
        const overnight = (sizing: ShareSizing) => ({
          f4: replayDaily(daily, tier.f4, 'f4', sizing, oneWayBps),
          o1: replayDaily(daily, tier.o1, 'o1', sizing, oneWayBps),
        })
        const wholeDaily = overnight(ShareSizing.Whole)
        const fractionalDaily = overnight(ShareSizing.Fractional)

        return Object.values(IntradayVariant).map((variant) => {
          const run = (sizing: ShareSizing, { f4, o1 }: typeof wholeDaily) => {
            let equity: number = tier.intraday
            let fills = 0
            let withheldShorts = 0
            let heldGaps = 0
            const closes = intraday[variant].map((session) => {
              const day = tradeIntraday(session, equity, tier.mode, sizing, oneWayBps)
              equity = positiveEquity(equity + day.pnl, session.date)
              fills += day.fills
              withheldShorts += day.withheldShorts
              heldGaps += day.heldGaps
              return equity
            })
            // This is a consolidated view of three isolated accounts, not a daily
            // constant-weight portfolio or permission to net cash/orders between them.
            const combined = closes.map((eq, i) => eq + f4[i] + o1[i])
            const net = {
              intraday: returns(closes, tier.intraday),
              f4: returns(f4, tier.f4),
              o1: returns(o1, tier.o1),
              combined: returns(combined, tier.totalUsd),
            }
            const accountMetrics = {
              intraday: metrics(closes, net.intraday, tier.intraday, years),
              f4: metrics(f4, net.f4, tier.f4, years),
              o1: metrics(o1, net.o1, tier.o1, years),
            }
            return {
              net,
              accountMetrics,
              combined: metrics(combined, net.combined, tier.totalUsd, years),
              correlation: correlations(net),
              pdt: {
                thresholdAppliesInLegacyScenario: tier.mode === IntradayMode.UnleveredLongShort,
                ...assessPdtBuffer(tier.intraday, closes, accountMetrics.intraday.maxDrawdown),
              },
              intradayExecution: { fills, withheldShorts, heldGaps },
            }
          }
          const { net: wholeNet, ...whole } = run(ShareSizing.Whole, wholeDaily)
          const { net: fractionalNet, ...fractional } = run(ShareSizing.Fractional, fractionalDaily)
          const tracking = (id: (typeof correlationOrder)[number]) =>
            compare(whole.accountMetrics[id], fractional.accountMetrics[id], wholeNet[id], fractionalNet[id])

          return {
            tier,
            variant,
            oneWayBps,
            whole,
            fractional,
            rounding: {
              combined: compare(whole.combined, fractional.combined, wholeNet.combined, fractionalNet.combined),
              intraday: tracking('intraday'),
              f4: tracking('f4'),
              o1: tracking('o1'),
            },
          }
        })
      })
    }),
  }
}
