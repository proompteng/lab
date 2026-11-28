import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted, Schema } from 'effect'
import { Matrix, SingularValueDecomposition } from 'ml-matrix'

import { sha256 } from '../src/hash'
import { splits } from './noise-area-study-replay'
import {
  Control,
  loadStudy,
  roster,
  type FactorRow,
  type PullbackEtf,
  type TradingSession,
} from './research-10yr-etf-mean-reversion-data'
import { elapsedDays, foldBounds, requireAlignedSessions } from './research-lib/calendar'
import {
  calmar,
  dailySharpe,
  deflatedSharpe,
  expectedMaximumSharpe,
  maxDrawdown,
  mean,
  sharpe,
  sortino,
  stationaryBootstrap,
  stationaryMeanP,
  sum,
  wealth,
} from './research-lib/statistics'
import { pearson } from './research-orb-zab-statistics'

export const thresholds = [10, 15, 20] as const
const primaryThreshold = thresholds[0]
const costs = [0, 2, 5, 10] as const
const trendSessions = 200
const exitSessions = 5
const volatilitySessions = 20
const maxHold = 5
const breakevenCeiling = 1_000
const annualSessions = 252
const bootstrap = { draws: 10_000, meanBlock: 5, seed: 0x19a2026 }
const factors = Object.values(Control)
const comparisonSleeves = [Control.B0, Control.F4, Control.O1]
const registration = {
  initialCommit: 'b4ff39f7443141f314d0fa0d15491c6c739fdca1',
  commit: 'a52e261e1fcce7e423ad1cd2a9825bb4a6858aba',
  sha256: 'ebeaf6fbbda9cb1f6fa57ba80e529bdd3700293acaa684276b9c9aeb32c4b233',
}
const protocol = new URL('../../../docs/bayn/evidence/2026-11-27-10yr-etf-mean-reversion/protocol.md', import.meta.url)

const sampleDeviation = (values: readonly number[]) => {
  if (values.length < 2 || values.every((value) => value === values[0])) return 0
  const center = mean(values)
  return Math.sqrt(sum(values.map((value) => (value - center) ** 2)) / (values.length - 1))
}

export const wilderRsi2 = (closes: readonly number[]) => {
  let gain = 0
  let loss = 0
  return closes.map((close, t) => {
    if (t === 0) return null
    const change = close - closes[t - 1]
    gain = (t <= 2 ? gain : gain / 2) + Math.max(change, 0) / 2
    loss = (t <= 2 ? loss : loss / 2) + Math.max(-change, 0) / 2
    return t === 1 ? null : gain + loss > 0 ? (100 * gain) / (gain + loss) : 50
  })
}

export const prepareSignals = (sessions: readonly TradingSession[]) => {
  requireAlignedSessions(sessions)
  const universe = sessions[0]?.quotes.map(({ symbol }) => symbol) ?? []
  if (universe.length === 0 || new Set(universe).size !== universe.length) throw new Error('Invalid study roster')
  if (
    sessions.some(
      ({ quotes }) => quotes.length !== universe.length || quotes.some(({ symbol }, i) => symbol !== universe[i]),
    )
  )
    throw new Error('ETF quote roster changed within the replay')

  const signals = universe.map((_, i) => {
    const closes = sessions.map(({ quotes }) => quotes[i].signalClose)
    const returns = closes.slice(1).map((close, t) => close / closes[t] - 1)
    const rsi = wilderRsi2(closes)
    return closes.map((close, t) => {
      const vol = t < volatilitySessions ? 0 : sampleDeviation(returns.slice(t - volatilitySessions, t))
      return {
        rsi: rsi[t],
        aboveTrend: t + 1 >= trendSessions && close > mean(closes.slice(t + 1 - trendSessions, t + 1)),
        aboveExit: t + 1 >= exitSessions && close > mean(closes.slice(t + 1 - exitSessions, t + 1)),
        inverseVol: vol > 0 ? 1 / vol : 0,
      }
    })
  })
  return sessions.map(({ date, quotes }, t) => {
    const total = sum(signals.map((symbol) => symbol[t].inverseVol))
    return {
      date,
      quotes: quotes.map((quote, i) => ({
        ...quote,
        ...signals[i][t],
        weight: total > 0 ? signals[i][t].inverseVol / total : 0,
      })),
    }
  })
}

enum ExitReason {
  Rebound = 'above-5-session-sma',
  TimeLimit = 'five-session-limit',
}
type Entry = {
  readonly symbol: PullbackEtf
  readonly signalDate: string
  readonly entryDate: string
  readonly entryIndex: number
  readonly entryPrice: number
  readonly units: number
  readonly debit: number
}
type Trade = Entry & {
  readonly exitDate: string
  readonly exitPrice: number
  readonly exitReason: ExitReason
  readonly holdingSessions: number
  readonly netPnl: number
}
type DailyReturn = { readonly date: string; readonly net: number; readonly oneWayTurnover: number }

export const replay = (
  sessions: ReturnType<typeof prepareSignals>,
  threshold: (typeof thresholds)[number],
  oneWayBp: number,
) => {
  if (!Number.isFinite(oneWayBp) || oneWayBp < 0 || oneWayBp > breakevenCeiling) throw new Error('Invalid one-way cost')
  const fee = oneWayBp / 10_000
  const held = new Map<PullbackEtf, Entry>()
  const trades: Trade[] = []
  let pendingBuys = new Map<PullbackEtf, number>()
  let pendingSells = new Map<PullbackEtf, ExitReason>()
  let cash = 1
  let equity = 1
  const days = sessions.map(({ date, quotes }, t): DailyReturn => {
    const opening = cash + sum(quotes.map(({ symbol, open }) => (held.get(symbol)?.units ?? 0) * open))
    if (!(opening > 0) || !Number.isFinite(opening)) throw new Error(`Invalid opening NAV on ${date}`)
    let sells = 0
    for (const { symbol, open } of quotes) {
      const exitReason = pendingSells.get(symbol)
      const position = held.get(symbol)
      if (exitReason === undefined) continue
      if (position === undefined) throw new Error(`Exit without a position: ${symbol} ${date}`)
      const holdingSessions = t - position.entryIndex
      if (holdingSessions < 1 || holdingSessions > maxHold) throw new Error(`Invalid holding period: ${symbol} ${date}`)
      const sale = position.units * open
      const proceeds = sale * (1 - fee)
      sells += sale
      cash += proceeds
      trades.push({
        ...position,
        exitDate: date,
        exitPrice: open,
        exitReason,
        holdingSessions,
        netPnl: proceeds - position.debit,
      })
      held.delete(symbol)
    }

    const desired = opening * sum([...pendingBuys.values()])
    const scale = desired > 0 ? Math.min(1, cash / (desired * (1 + fee))) : 0
    let buys = 0
    for (const { symbol, open } of quotes) {
      const notional = opening * (pendingBuys.get(symbol) ?? 0) * scale
      if (notional === 0) continue
      if (held.has(symbol) || pendingSells.has(symbol) || t === 0)
        throw new Error(`Conflicting entry: ${symbol} ${date}`)
      const debit = notional * (1 + fee)
      buys += notional
      held.set(symbol, {
        symbol,
        signalDate: sessions[t - 1].date,
        entryDate: date,
        entryIndex: t,
        entryPrice: open,
        units: notional / open,
        debit,
      })
    }
    cash -= buys * (1 + fee)
    if (cash < -1e-12 * opening) throw new Error(`Unfunded orders on ${date}`)
    cash = Math.max(0, cash) // Floating-point residue only.
    const closing = cash + sum(quotes.map(({ symbol, close }) => (held.get(symbol)?.units ?? 0) * close))
    if (!(closing > 0) || !Number.isFinite(closing)) throw new Error(`Invalid closing NAV on ${date}`)

    // These orders are decided after this close and cannot execute until the following regular open.
    pendingBuys = new Map()
    pendingSells = new Map()
    for (const { symbol, rsi, aboveTrend, aboveExit, weight } of quotes) {
      const position = held.get(symbol)
      if (position === undefined) {
        if (aboveTrend && rsi !== null && rsi < threshold && weight > 0) pendingBuys.set(symbol, weight)
      } else if (t - position.entryIndex + 1 >= maxHold) {
        pendingSells.set(symbol, ExitReason.TimeLimit)
      } else if (aboveExit) {
        pendingSells.set(symbol, ExitReason.Rebound)
      }
    }
    const net = closing / equity - 1
    equity = closing
    return { date, net, oneWayTurnover: (buys + sells) / (2 * opening) }
  })
  return { days, trades, openLots: [...held.values()] }
}

export const breakevenBp = (netAt: (bp: number) => number) => {
  let lower = 0
  let upper = breakevenCeiling
  if (!(netAt(lower) > 0) || !(netAt(upper) <= 0)) return null
  for (let i = 0; i < 32; i++) {
    const mid = (lower + upper) / 2
    if (netAt(mid) > 0) lower = mid
    else upper = mid
  }
  return (lower + upper) / 2
}

export const factorResiduals = (
  days: readonly DailyReturn[],
  controls: readonly FactorRow[],
  developmentSessions: number,
) => {
  requireAlignedSessions(days, controls)
  const x = controls.map(({ returns }) => factors.map((factor) => returns[factor]))
  const net = days.map(({ net }) => net)
  if (developmentSessions <= factors.length || developmentSessions >= days.length)
    throw new Error('Invalid factor fit boundary')
  const fit = new SingularValueDecomposition(new Matrix(x.slice(0, developmentSessions).map((row) => [1, ...row])))
  if (fit.rank !== factors.length + 1) throw new Error('Development factors are rank deficient')
  const [intercept, ...slopes] = fit.solve(Matrix.columnVector(net.slice(0, developmentSessions))).getColumn(0)
  if (![intercept, ...slopes].every(Number.isFinite)) throw new Error('Non-finite development exposure')
  return {
    developmentIntercept: intercept,
    betas: Object.fromEntries(factors.map((factor, i) => [factor, slopes[i]])),
    residuals: net.map((value, t) => value - sum(x[t].map((factor, j) => factor * slopes[j]))),
  }
}

const metrics = (days: readonly DailyReturn[], trades: readonly Trade[]) => {
  const returns = days.map(({ net }) => net)
  const from = days[0].date
  const through = days[days.length - 1].date
  const years = (elapsedDays(from, through) + 1) / 365.2425
  const finalNav = wealth(returns, true)
  const cagr = finalNav ** (1 / years) - 1
  const maxDd = maxDrawdown(returns, true)
  const closed = trades.filter(({ exitDate }) => exitDate >= from && exitDate <= through)
  const wins = closed.filter(({ netPnl }) => netPnl > 0)
  const losses = -sum(closed.filter(({ netPnl }) => netPnl < 0).map(({ netPnl }) => netPnl))
  return {
    cumulativeReturn: finalNav - 1,
    cagr,
    volatility: sampleDeviation(returns) * Math.sqrt(annualSessions),
    sharpe: sharpe(returns),
    sortino: sortino(returns),
    maxDrawdown: maxDd,
    calmar: calmar(cagr, maxDd),
    annualOneWayTurnover: mean(days.map(({ oneWayTurnover }) => oneWayTurnover)) * annualSessions,
    closedTrades: closed.length,
    winRate: closed.length > 0 ? wins.length / closed.length : null,
    profitFactor: losses > 0 ? sum(wins.map(({ netPnl }) => netPnl)) / losses : null,
  }
}

const trialId = (threshold: (typeof thresholds)[number]) => `RSI2-${threshold}`
const annualReturns = (days: readonly DailyReturn[]) => {
  const years = Map.groupBy(days, ({ date }) => date.slice(0, 4))
  return Object.fromEntries(
    [...years].map(([year, rows]) => [
      year,
      {
        sessions: rows.length,
        return:
          wealth(
            rows.map(({ net }) => net),
            true,
          ) - 1,
      },
    ]),
  )
}

enum Verdict {
  Promote = 'PROMOTE',
  DoNotPromote = 'DO NOT PROMOTE',
}

const score = ({
  sessions,
  controls,
  admitted,
  coverage,
  receipts,
  intradayCoverage,
}: Effect.Success<typeof loadStudy>) => {
  const dates = sessions.map(({ date }) => date)
  const { first: holdoutStart, end } = foldBounds(
    dates,
    splits.holdout.first,
    splits.holdout.last,
    splits.holdout.count,
  )
  if (
    dates[0] !== splits.train.first ||
    holdoutStart !== splits.train.count + splits.validation.count ||
    end !== dates.length
  )
    throw new Error('Unexpected Wave 19R calendar')
  const prepared = prepareSignals(sessions)
  const ranges = { full: 0, holdout: holdoutStart }
  const plans = {
    full: stationaryBootstrap(end, bootstrap),
    holdout: stationaryBootstrap(end - holdoutStart, bootstrap),
  }
  const costStress = costs.map((oneWayBp) => {
    const controlsAtCost = controls.atCost(oneWayBp)
    const tapes = thresholds.map((threshold) => replay(prepared, threshold, oneWayBp))
    const nets = tapes.map(({ days }) => days.map(({ net }) => net))
    const dailySharpes = nets.map((net) => dailySharpe(net.slice(0, holdoutStart)))
    const benchmark = dailySharpes.every((value): value is number => value !== null)
      ? expectedMaximumSharpe(dailySharpes, thresholds.length)
      : null
    const vectors = [...factors.map((factor) => controlsAtCost.map(({ returns }) => returns[factor])), ...nets]
    const correlation = (start: number) => {
      const aligned = vectors.map((series) => series.slice(start))
      return aligned.map((a) => aligned.map((b) => pearson(a, b)))
    }
    const trials = tapes.map(({ days, trades, openLots }, i) => {
      const { residuals, ...developmentFit } = factorResiduals(days, controlsAtCost, holdoutStart)
      const window = (key: keyof typeof ranges) => {
        const from = ranges[key]
        const returns = nets[i].slice(from)
        const residual = residuals.slice(from)
        return {
          ...metrics(days.slice(from), trades),
          dsr: deflatedSharpe(returns, benchmark),
          stationaryP: stationaryMeanP(returns, plans[key]),
          alphaAnnualized: mean(residual) * annualSessions,
          alphaStationaryP: stationaryMeanP(residual, plans[key]),
        }
      }
      return {
        id: trialId(thresholds[i]),
        full: window('full'),
        holdout: window('holdout'),
        annualReturns: annualReturns(days),
        developmentFit,
        sameSessionRoundTrips: trades.filter(({ holdingSessions }) => holdingSessions === 0).length,
        maxClosedHoldingSessions: Math.max(0, ...trades.map(({ holdingSessions }) => holdingSessions)),
        openAtEnd: openLots.map(({ symbol, entryDate }) => ({ symbol, entryDate })),
        ledgerSha256: sha256(JSON.stringify({ days, trades, openLots })),
      }
    })
    return {
      oneWayBp,
      developmentDailySharpes: dailySharpes,
      deflationBenchmarkDailySharpe: benchmark,
      correlation: { full: correlation(0), holdout: correlation(holdoutStart) },
      controlsSha256: sha256(JSON.stringify(controlsAtCost)),
      trials,
    }
  })

  const gates = costStress
    .filter(({ oneWayBp }) => oneWayBp >= 5)
    .map(({ oneWayBp, correlation, trials }) => {
      const primary = trials[0]
      const correlations = comparisonSleeves.map(
        (control) => correlation.holdout[factors.length][factors.indexOf(control)],
      )
      return {
        oneWayBp,
        positiveCagr: primary.holdout.cagr > 0,
        positiveResidualAlpha: primary.holdout.alphaAnnualized > 0,
        lowSleeveCorrelations: correlations.every((value) => value !== null && Math.abs(value) < 0.3),
        zeroSameSessionRoundTrips: primary.sameSessionRoundTrips === 0,
      }
    })
  const primaryAtFive = costStress.find(({ oneWayBp }) => oneWayBp === 5)?.trials[0].holdout
  if (primaryAtFive === undefined) throw new Error('Missing registered 5 bp scenario')
  const dsrPass = primaryAtFive.dsr !== null && primaryAtFive.dsr >= 0.95
  const pPass = primaryAtFive.alphaStationaryP !== null && primaryAtFive.alphaStationaryP < 0.05
  const completeRoster = admitted.length === roster.length
  const verdict =
    completeRoster &&
    dsrPass &&
    pPass &&
    gates.every(({ oneWayBp: _bp, ...outcomes }) => Object.values(outcomes).every(Boolean))
      ? Verdict.Promote
      : Verdict.DoNotPromote
  return {
    schemaVersion: 'bayn.wave19r.etf-mean-reversion.v1',
    registration,
    archiveReceipts: receipts,
    intradayCoverage,
    admitted,
    candidateCoverage: coverage,
    controls: controls.evidence,
    windows: {
      development: { from: dates[0], through: dates[holdoutStart - 1], sessions: holdoutStart },
      holdout: { from: dates[holdoutStart], through: dates[end - 1], sessions: end - holdoutStart },
      full: { from: dates[0], through: dates[end - 1], sessions: end },
      signalWarmupSessions: trendSessions - 1,
      firstPossibleEntry: dates[trendSessions],
    },
    exactTrialCount: thresholds.length,
    primary: trialId(primaryThreshold),
    bootstrap,
    correlationOrder: [...factors, ...thresholds.map(trialId)],
    costStress,
    breakeven: thresholds.map((threshold) => {
      const at = (from: number) =>
        breakevenBp(
          (bp) =>
            wealth(
              replay(prepared, threshold, bp)
                .days.slice(from)
                .map(({ net }) => net),
              true,
            ) - 1,
        )
      return { id: trialId(threshold), fullOneWayBp: at(0), holdoutOneWayBp: at(holdoutStart) }
    }),
    decision: { verdict, completeRoster, dsrPass, pPass, gates },
  }
}

class StudyError extends Data.TaggedError('EtfMeanReversionStudyError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const failure = (message: string) => (cause: unknown) => new StudyError({ message, cause: Redacted.make(cause) })
const decodeArgs = Schema.decodeUnknownSync(Schema.Struct({ output: Schema.NonEmptyString }))
const main = Effect.gen(function* () {
  const { output } = yield* Effect.try({
    try: () => decodeArgs(parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } } }).values),
    catch: failure('Expected --output NEW_RESULTS.json'),
  })
  const protocolBytes = yield* Effect.tryPromise({
    try: (signal) => readFile(protocol, { signal }),
    catch: failure('Cannot read the registered Wave 19R protocol'),
  })
  if (sha256(protocolBytes) !== registration.sha256)
    return yield* new StudyError({ message: 'Wave 19R protocol digest mismatch' })
  const input = yield* loadStudy
  const result = yield* Effect.try({ try: () => score(input), catch: failure('Wave 19R scoring failed') })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', signal }),
    catch: failure('Cannot write new Wave 19R results'),
  })
  yield* Effect.logInfo(
    `Wave 19R: ${result.decision.verdict}; ${result.windows.full.sessions} sessions, ${result.admitted.length} ETFs, ${result.exactTrialCount} trials`,
  )
})

if (import.meta.main) NodeRuntime.runMain(main)
