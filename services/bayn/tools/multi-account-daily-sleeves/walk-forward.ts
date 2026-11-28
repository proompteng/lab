import { Result } from 'effect'

import { canaryPolicyV2 } from '../../src/strategy/macro-canary-etf/policy'
import { planMacroCanaryEtfRebalanceV2 } from '../../src/strategy/macro-canary-etf/rebalance-planner'
import { planMacroEtfCoreRebalanceV2, wholeShareCost } from '../../src/strategy/macro-etf-core/planner'
import { corePolicyV2, type Etf, Profile } from '../../src/strategy/macro-etf-core/policy'
import { MacroRiskMode, MacroRiskState } from '../../src/strategy/macro-portfolio/risk'
import { prepareMacroPortfolioV2, sizeMacroPortfolioV2 } from '../../src/strategy/macro-portfolio/targets'
import { elapsedDays, requireAlignedSessions } from '../research-lib/calendar'
import { maxDrawdown, mean, sharpe, sortino, sum } from '../research-lib/statistics'
import { costs } from '../research/macro-etf-core-dual-horizon-account'
import { closeEvidence, type DailyFrame } from '../research/macro-etf-core-dual-horizon-data'
import { replayDaily, ShareSizing, type DailySession } from '../three-account-capital-core'

export const start = { f4: 35_000, o1: 25_000 } as const
export const targetVolatility = 0.1
const annualSessions = 252
const micros = (usd: number) => BigInt(Math.round(usd * 1_000_000))
const usd = (value: bigint) => Number(value) / 1_000_000

export type Cost = (typeof costs)[number]
type Book = { cash: bigint; shares: Map<Etf, bigint> }
type Day = {
  date: string
  f4: number
  o1: number
  tradedUsd: number
  riskState?: MacroRiskState
  openingGross?: number
}

const mark = (frame: DailyFrame, symbol: Etf, at: 'open' | 'close') => {
  const price = frame.bars.get(symbol)?.[at]
  if (price === undefined || !Number.isFinite(price) || price <= 0)
    throw new Error(`Missing ${at} mark: ${symbol} ${frame.date}`)
  return micros(price)
}

const equity = ({ cash, shares }: Book, frame: DailyFrame) => {
  let nav = cash
  for (const [symbol, qty] of shares) nav += qty * mark(frame, symbol, 'close')
  if (nav <= 0n) throw new Error(`Nonpositive closing macro equity: ${frame.date}`)
  return nav
}

const initialBook = (funds: number, frame: DailyFrame, bps: Cost) => {
  const price = mark(frame, 'SHY', 'open')
  const opening = micros(funds)
  const shares = (opening * 10_000n) / (price * BigInt(10_000 + bps))
  const notional = shares * price
  return {
    book: {
      cash: opening - notional - wholeShareCost(notional, 'buy', bps),
      shares: new Map<Etf, bigint>(shares > 0n ? [['SHY', shares]] : []),
    },
    notional,
    gross: Number(notional) / Number(opening - wholeShareCost(notional, 'buy', bps)),
  }
}

/** Applies the production target and lot planner; only the execution marks and fills are simulated. */
const replayCash = (
  frames: readonly DailyFrame[],
  prepared: Result.Result.Success<ReturnType<typeof prepareMacroPortfolioV2>>,
  oneWayBps: Cost,
): readonly Day[] => {
  const f4Policy = { schema: corePolicyV2, profile: Profile.F4, risk: prepared.risk }
  const o1Policy = { schemaVersion: canaryPolicyV2, risk: prepared.risk }
  const decisions = new Map(prepared.basis.map((basis) => [basis.schedule.executionDate, basis]))
  const f4Start = initialBook(start.f4, frames[0], oneWayBps)
  const o1Start = initialBook(start.o1, frames[0], oneWayBps)
  const f4 = f4Start.book
  const o1 = o1Start.book
  let highWaterMicros = micros(start.f4 + start.o1)

  return frames.map((frame, i) => {
    const prior = frames[i - 1]
    const decision = decisions.get(frame.date)
    let traded = i === 0 ? f4Start.notional + o1Start.notional : 0n
    let openingGross = i === 0 ? Math.max(f4Start.gross, o1Start.gross) : undefined
    let riskState: MacroRiskState | undefined
    if (decision !== undefined) {
      if (prior === undefined || decision.schedule.signalDate !== prior.date)
        throw new Error(`Unpaired macro decision for ${frame.date}`)
      const f4EquityMicros = equity(f4, prior)
      const o1EquityMicros = equity(o1, prior)
      const target = Result.getOrThrow(
        sizeMacroPortfolioV2(prepared, decision, {
          signalDate: prior.date,
          f4EquityMicros,
          o1EquityMicros,
          highWaterMicros,
        }),
      )
      riskState = target.f4.riskState
      const marks = [...frame.bars.keys()].map((symbol) => ({
        symbol,
        openAt: frame.openAt,
        availableAt: frame.openAt,
        openMicros: mark(frame, symbol, 'open'),
        ...(!prior.bars.has(symbol)
          ? {}
          : { priorCloseAt: prior.closeAt, priorCloseMicros: mark(prior, symbol, 'close') }),
        marginable: false,
      }))
      for (const sleeve of ['f4', 'o1'] as const) {
        const book = sleeve === 'f4' ? f4 : o1
        const priorEquityMicros = sleeve === 'f4' ? f4EquityMicros : o1EquityMicros
        const inputs = {
          asOf: frame.openAt,
          cashMicros: book.cash,
          // Model sale proceeds settling at the next regular opening (T+1).
          settledCashMicros: book.cash,
          priorEquityMicros,
          debitCapMicros: 0n,
          grossCapMicros: micros(150_000),
          oneWayBps,
          positions: [...book.shares].map(([symbol, shares]) => ({ symbol, shares })),
          protectedSymbols: [],
          marks,
        }
        const plan = Result.getOrThrowWith(
          sleeve === 'f4'
            ? planMacroEtfCoreRebalanceV2(f4Policy, target.f4, inputs)
            : planMacroCanaryEtfRebalanceV2(o1Policy, target.o1, inputs),
          (cause) => new Error(`Invalid ${sleeve} opening plan on ${frame.date}`, { cause }),
        )
        book.cash = plan.cashMicros
        for (const order of plan.orders) {
          const qty = (book.shares.get(order.symbol) ?? 0n) + (order.side === 'buy' ? order.shares : -order.shares)
          if (qty === 0n) book.shares.delete(order.symbol)
          else book.shares.set(order.symbol, qty)
          traded += order.priceMicros * order.shares
        }
        openingGross = Math.max(
          openingGross ?? 0,
          Number(plan.grossMicros) / Number(plan.cashMicros + plan.grossMicros),
        )
      }
    }
    const a = equity(f4, frame)
    const b = equity(o1, frame)
    if (a + b > highWaterMicros) highWaterMicros = a + b
    return {
      date: frame.date,
      f4: usd(a),
      o1: usd(b),
      tradedUsd: usd(traded),
      ...(riskState === undefined ? {} : { riskState }),
      ...(openingGross === undefined ? {} : { openingGross }),
    }
  })
}

export const prepareCashWalkForward = (frames: readonly DailyFrame[]) => {
  const prepared = Result.getOrThrow(
    prepareMacroPortfolioV2({ mode: MacroRiskMode.Cash, targetVolatility }, closeEvidence(frames)),
  )
  const { f4PolicyHash, o1PolicyHash } = prepared
  return {
    policyHashes: { f4PolicyHash, o1PolicyHash },
    replay: (bps: Cost) => replayCash(frames, prepared, bps),
  }
}

export const replayFrozenPair = (daily: readonly DailySession[], bps: Cost): readonly Day[] => {
  const traded = daily.map(() => 0)
  const trade = (i: number, notional: number) => {
    traded[i] += notional
  }
  const f4 = replayDaily(daily, start.f4, 'f4', ShareSizing.Whole, bps, trade)
  const o1 = replayDaily(daily, start.o1, 'o1', ShareSizing.Whole, bps, trade)
  return daily.map(({ date }, i) => ({ date, f4: f4[i], o1: o1[i], tradedUsd: traded[i] }))
}

export const pairedMetrics = (path: readonly Day[], first = 0, end = path.length) => {
  const rows = path.slice(first, end)
  if (rows.length < 2) throw new Error('At least two observed sessions are required')
  const returns = rows.map((day, i) => {
    const before = path[first + i - 1] ?? start
    const previous = before.f4 + before.o1
    return {
      f4: day.f4 / before.f4 - 1,
      o1: day.o1 / before.o1 - 1,
      joint: (day.f4 + day.o1) / previous - 1,
      turnover: day.tradedUsd / (2 * previous),
    }
  })
  const firstEquity = path[first - 1] ?? start
  const last = rows[rows.length - 1]
  const years = (elapsedDays(rows[0].date, last.date) + 1) / 365.2425
  const joint = returns.map(({ joint }) => joint)
  const avg = mean(joint)
  const variance = sum(joint.map((r) => (r - avg) ** 2)) / (joint.length - 1)
  const f4Mean = mean(returns.map(({ f4 }) => f4))
  const o1Mean = mean(returns.map(({ o1 }) => o1))
  const f4Center = returns.map(({ f4 }) => f4 - f4Mean)
  const o1Center = returns.map(({ o1 }) => o1 - o1Mean)
  const denom = Math.sqrt(sum(f4Center.map((x) => x ** 2)) * sum(o1Center.map((x) => x ** 2)))
  const gross = rows.flatMap(({ openingGross }) => (openingGross === undefined ? [] : [openingGross]))
  return {
    sessions: rows.length,
    first: rows[0].date,
    last: last.date,
    years,
    cagr: ((last.f4 + last.o1) / (firstEquity.f4 + firstEquity.o1)) ** (1 / years) - 1,
    volatility: Math.sqrt(annualSessions * variance),
    sharpe: sharpe(joint),
    sortino: sortino(joint),
    maxDrawdown: maxDrawdown(joint, true),
    oneWayTurnover: annualSessions * mean(returns.map(({ turnover }) => turnover)),
    correlation: denom > 0 ? sum(f4Center.map((r, i) => r * o1Center[i])) / denom : null,
    maxOpeningGross: gross.length === 0 ? null : Math.max(...gross),
    brakeSessions: rows.filter(({ riskState }) => riskState === MacroRiskState.Brake).length,
    haltSessions: rows.filter(({ riskState }) => riskState === MacroRiskState.Halt).length,
  }
}

export const costSweep = (frames: readonly DailyFrame[], daily: readonly DailySession[], first: number) => {
  requireAlignedSessions(frames, daily)
  const cash = prepareCashWalkForward(frames)
  return {
    policyHashes: cash.policyHashes,
    scenarios: costs.map((bps) => ({
      bps,
      baseline: pairedMetrics(replayFrozenPair(daily, bps), first),
      cash: pairedMetrics(cash.replay(bps), first),
    })),
  }
}
