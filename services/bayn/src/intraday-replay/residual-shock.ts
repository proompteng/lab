import { Data, Result } from 'effect'

import { numberToMicros } from '../execution-model'
import type { JevProtocol } from '../jev/protocol'
import { usesCandidateWindowTrade, type IntradayBar } from '../market-data/intraday/model'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { compareRecords } from '../market-data/intraday/verification'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'

export enum ResidualShockCandidate {
  SpyRelativeShockRebound60s = 'SPY_RELATIVE_SHOCK_REBOUND_60S_V1',
}

/** A frozen falsification hypothesis, not a fitted model or a profitability claim. */
export const residualShockDefinition = Object.freeze({
  schemaVersion: 'bayn.residual-shock-falsification.v1',
  id: ResidualShockCandidate.SpyRelativeShockRebound60s,
  classification: 'RESEARCH_ONLY_FALSIFICATION',
  bars: 30,
  baselineReturns: 28,
  returnDefinition: '10000 * (current close / previous close - 1); stock minus SPY, coefficient one',
  arithmetic: 'Exact rational arithmetic after the native micro-dollar price conversion; no return rounding',
  variance: 'Sample variance of the preceding 28 residual returns, denominator 27; the latest return is excluded',
  selection: 'Latest stock return < 0, latest residual < 0, centered residual < 0, squared z >= 95481/10000',
  ranking: 'Squared z descending, then symbol ascending; all eligible centered residuals are negative',
  zeroVariance: 'NO_SIGNAL',
  unavailable: 'Malformed or missing required evidence is UNAVAILABLE; native candidate exclusions are retained',
  evidence: 'Point-in-time verified IEX bars and native publication policy; no imputation or later revisions',
  pollIntervalMs: 30_000,
  barDelaySeconds: 2,
  maximumQuoteAgeMs: 10_000,
  maximumSpreadBps: 5,
  targetWeightPpm: 200_000,
  targetHoldingMs: 60_000,
  protectiveStopBps: 50,
  flattenMinutesBeforeClose: 5,
  lifecycle:
    'Close and protective stop precede the target. Target exit starts at the first poll at or after first fill plus 60 seconds; routing and partial-fill retries can delay flattening. One entry attempt per observed minute window.',
  execution:
    'Shared native control portfolio sizing, IOC quote-side fills, liquidity consumption, costs, risk and reducing retries',
  limitations:
    'Development evidence only. Original receipts, complete future opportunities and calibrated execution are required for qualification. Exposed historical sessions are never held out. No model calls, live registration or capital authority.',
} as const)

export class ResidualShockFailure extends Data.TaggedError('ResidualShockFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface Ratio {
  readonly numerator: bigint
  readonly denominator: bigint
}
export interface ResidualShockRatio {
  readonly numerator: string
  readonly denominator: string
}

const ratio = (numerator: bigint, denominator = 1n): Ratio => {
  let a = numerator < 0n ? -numerator : numerator
  let b = denominator
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return { numerator: numerator / a, denominator: denominator / a }
}
const add = (a: Ratio, b: Ratio) =>
  ratio(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator)
const subtract = (a: Ratio, b: Ratio) => add(a, { ...b, numerator: -b.numerator })
const square = (a: Ratio) => ratio(a.numerator * a.numerator, a.denominator * a.denominator)
const divide = (a: Ratio, b: Ratio) => ratio(a.numerator * b.denominator, a.denominator * b.numerator)
const compare = (a: Ratio, b: Ratio) => a.numerator * b.denominator - b.numerator * a.denominator
const serialize = (a: Ratio): ResidualShockRatio => ({
  numerator: String(a.numerator),
  denominator: String(a.denominator),
})

export enum ResidualShockStatus {
  Eligible = 'ELIGIBLE',
  NoShock = 'NO_SHOCK',
  ZeroVariance = 'ZERO_VARIANCE',
  SourceExcluded = 'SOURCE_EXCLUDED',
  Illiquid = 'ILLIQUID',
}

export const calculateResidualShock = (stock: readonly bigint[], benchmark: readonly bigint[]) =>
  Result.gen(function* () {
    if (stock.length !== 30 || benchmark.length !== 30 || [...stock, ...benchmark].some((price) => price <= 0n))
      return yield* Result.fail(
        new ResidualShockFailure({ message: 'Residual shock requires 30 positive aligned closes' }),
      )
    const residuals: Ratio[] = []
    let latestStock = ratio(0n)
    for (let index = 1; index < 30; index++) {
      const current = stock[index]
      const previous = stock[index - 1]
      const market = benchmark[index]
      const previousMarket = benchmark[index - 1]
      if (current === undefined || previous === undefined || market === undefined || previousMarket === undefined)
        return yield* Result.fail(new ResidualShockFailure({ message: 'Residual shock close index is missing' }))
      latestStock = ratio(10_000n * (current - previous), previous)
      residuals.push(subtract(latestStock, ratio(10_000n * (market - previousMarket), previousMarket)))
    }
    const baseline = residuals.slice(0, 28)
    const latest = residuals[28]
    if (latest === undefined)
      return yield* Result.fail(new ResidualShockFailure({ message: 'Residual shock latest return is missing' }))
    const mean = divide(baseline.reduce(add, ratio(0n)), ratio(28n))
    const variance = divide(baseline.map((value) => square(subtract(value, mean))).reduce(add, ratio(0n)), ratio(27n))
    const centered = subtract(latest, mean)
    const squaredZ = variance.numerator === 0n ? null : divide(square(centered), variance)
    const eligible =
      latestStock.numerator < 0n &&
      latest.numerator < 0n &&
      centered.numerator < 0n &&
      squaredZ !== null &&
      compare(squaredZ, ratio(95_481n, 10_000n)) >= 0n
    return {
      status:
        variance.numerator === 0n
          ? ResidualShockStatus.ZeroVariance
          : eligible
            ? ResidualShockStatus.Eligible
            : ResidualShockStatus.NoShock,
      latestStockReturnBps: serialize(latestStock),
      latestResidualBps: serialize(latest),
      baselineMeanBps: serialize(mean),
      baselineSampleVarianceBpsSquared: serialize(variance),
      centeredResidualBps: serialize(centered),
      squaredZ: squaredZ === null ? null : serialize(squaredZ),
    }
  })

const closes = (bars: readonly IntradayBar[], symbol: string, start: bigint) =>
  Result.gen(function* () {
    const selected = bars.filter((bar) => bar.symbol === symbol).toSorted(compareRecords)
    if (
      selected.length !== 30 ||
      selected.some((bar, index) => intradayInstantNanos(bar.eventAt) !== start + BigInt(index) * 60_000_000_000n)
    )
      return yield* Result.fail(
        new ResidualShockFailure({ message: `Residual shock requires 30 contiguous closes for ${symbol}` }),
      )
    const values = yield* Result.all(selected.map((bar) => numberToMicros(bar.close)))
    if (values.some((value) => value <= 0n))
      return yield* Result.fail(new ResidualShockFailure({ message: 'Residual shock close must be positive' }))
    return values
  }).pipe(
    Result.mapError(
      (cause) => new ResidualShockFailure({ message: `Cannot read residual shock closes for ${symbol}`, cause }),
    ),
  )

export const selectResidualShock = (snapshot: StrategyMarketSnapshot, protocol: JevProtocol) =>
  Result.gen(function* () {
    const now = intradayInstantNanos(snapshot.manifest.observedAt)
    const start = intradayInstantNanos(snapshot.manifest.rangeStartAt)
    const end = intradayInstantNanos(snapshot.manifest.rangeEndAt)
    if (end - start !== 30n * 60_000_000_000n || now < end + 2_000_000_000n)
      return yield* Result.fail(
        new ResidualShockFailure({ message: 'Residual shock window or completed-bar delay differs' }),
      )
    const latestTrades = Object.fromEntries(
      snapshot.trades.toSorted(compareRecords).map((trade) => [trade.symbol, trade]),
    )
    const liquid = (symbol: string) =>
      Result.gen(function* () {
        const quote = snapshot.latestQuotes[symbol]
        const trade = latestTrades[symbol]
        if (quote === undefined || trade === undefined)
          return yield* Result.fail(
            new ResidualShockFailure({ message: `Residual shock pricing evidence is missing for ${symbol}` }),
          )
        const bid = yield* numberToMicros(quote.bidPrice)
        const ask = yield* numberToMicros(quote.askPrice)
        if (bid <= 0n || ask < bid || !Number.isFinite(quote.bidSize) || !Number.isFinite(quote.askSize))
          return yield* Result.fail(
            new ResidualShockFailure({ message: `Residual shock pricing evidence is invalid for ${symbol}` }),
          )
        const times = usesCandidateWindowTrade(snapshot.manifest, symbol)
          ? [quote.eventAt]
          : [quote.eventAt, trade.eventAt]
        return (
          quote.bidSize > 0 &&
          quote.askSize > 0 &&
          intradayInstantNanos(trade.eventAt) <= now &&
          times.every((at) => {
            const age = now - intradayInstantNanos(at)
            return age >= 0n && age <= 10_000_000_000n
          }) &&
          (symbol === protocol.benchmarkSymbol || (ask - bid) * 20_000n <= 5n * (ask + bid))
        )
      }).pipe(
        Result.mapError(
          (cause) =>
            new ResidualShockFailure({ message: `Cannot validate residual shock liquidity for ${symbol}`, cause }),
        ),
      )
    if (!(yield* liquid(protocol.benchmarkSymbol)))
      return yield* Result.fail(new ResidualShockFailure({ message: 'Residual shock benchmark is stale or illiquid' }))
    const benchmark = yield* closes(snapshot.bars, protocol.benchmarkSymbol, start)
    const candidates = []
    for (const symbol of protocol.candidateSymbols) {
      const exclusion = snapshot.manifest.candidateExclusions?.find((entry) => entry.symbol === symbol)
      if (exclusion !== undefined) {
        candidates.push({ symbol, status: ResidualShockStatus.SourceExcluded, exclusion })
        continue
      }
      if (!(yield* liquid(symbol))) {
        candidates.push({ symbol, status: ResidualShockStatus.Illiquid })
        continue
      }
      candidates.push({
        symbol,
        ...(yield* calculateResidualShock(yield* closes(snapshot.bars, symbol, start), benchmark)),
      })
    }
    const ranked = candidates
      .flatMap((candidate) =>
        candidate.status === ResidualShockStatus.Eligible && 'squaredZ' in candidate && candidate.squaredZ !== null
          ? [{ symbol: candidate.symbol, squaredZ: candidate.squaredZ }]
          : [],
      )
      .toSorted((a, b) => {
        const left = a.squaredZ
        const right = b.squaredZ
        const difference =
          BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator)
        return difference === 0n ? (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) : difference > 0n ? -1 : 1
      })
    return { candidate: residualShockDefinition.id, selectedSymbol: ranked[0]?.symbol ?? null, candidates }
  })
