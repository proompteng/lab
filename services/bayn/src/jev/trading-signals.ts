import { Result } from 'effect'

import { numberToMicros } from '../strategy/execution-model/fixed-point'
import { deriveIntradayMomentumSignalMetrics } from '../strategy/intraday-momentum/decision-core'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { intradayAgeNanos } from '../market-data/intraday/time'
import { JevContractError, jevModel, prepareJevRequest, type JevRequest } from './contract'

const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

const signalFor = (snapshot: StrategyMarketSnapshot, symbol: string) =>
  Result.gen(function* () {
    const manifest = snapshot.manifest
    if (
      !manifest.symbols.includes(symbol) ||
      manifest.candidateExclusions?.some((entry) => entry.symbol === symbol) === true
    )
      return yield* unavailable('Jev signal subject is excluded or outside the verified snapshot')
    const rolling = manifest.streaming.features.find((entry) => entry.value.material.symbol === symbol)
    const quote = snapshot.latestQuotes[symbol]
    const trade = snapshot.trades
      .filter((entry) => entry.symbol === symbol)
      .toSorted((a, b) => a.eventAt.localeCompare(b.eventAt))
      .at(-1)
    const bars = snapshot.bars
      .filter((bar) => bar.symbol === symbol)
      .toSorted((a, b) => a.eventAt.localeCompare(b.eventAt))
    if (rolling === undefined || quote === undefined || trade === undefined || bars.length !== 30)
      return yield* unavailable('Jev signals require the verified rolling window, quote and trade')
    const quoteAgeMs = Number(intradayAgeNanos(manifest.observedAt, quote.eventAt)) / 1_000_000
    const tradeAgeMs = Number(intradayAgeNanos(manifest.observedAt, trade.eventAt)) / 1_000_000
    if ([quoteAgeMs, tradeAgeMs].some((age) => age < 0 || age > manifest.maximumQuoteAgeMs))
      return yield* unavailable('Jev signal pricing evidence is stale or future dated')
    const technical = manifest.streaming.technical?.features.find((entry) => entry.value.material.symbol === symbol)
    const technicalValues =
      technical === undefined
        ? null
        : Object.fromEntries(
            Object.entries(technical.value.material.values).map(([name, scalar]) => [
              name
                .replace(/PriceMicros$/, 'PriceUsd')
                .replace('rsi14Micros', 'rsi14')
                .replace('realizedVolatility60ReturnsPpm', 'realizedVolatility60ReturnsRatio'),
              { status: scalar.status, value: scalar.value === null ? null : Number(scalar.value) / 1_000_000 },
            ]),
          )
    const closes = bars.map((bar) => bar.close)
    const first = bars[0]
    const last = bars.at(-1)
    if (first === undefined || last === undefined) return yield* unavailable('Jev rolling signal window is empty')
    const returnsBps = Object.fromEntries(
      [1, 5, 15, 30].map((minutes) => {
        const reference = bars.at(-minutes)
        return [String(minutes), reference === undefined ? null : (last.close / reference.open - 1) * 10_000]
      }),
    )
    const earlyVolume = bars.slice(0, 15).reduce((total, bar) => total + bar.volume, 0)
    const recentVolume = bars.slice(15).reduce((total, bar) => total + bar.volume, 0)
    const minuteReturns = closes.slice(1).map((close, index) => Math.log(close / (closes[index] ?? close)))
    const mean = minuteReturns.reduce((sum, value) => sum + value, 0) / minuteReturns.length
    const volatilityBps =
      Math.sqrt(minuteReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / minuteReturns.length) * 10_000
    const values = rolling.value.material.values
    return {
      prices: {
        reference: BigInt(values.referencePriceMicros),
        high: BigInt(values.rangeHighPriceMicros),
        low: BigInt(values.rangeLowPriceMicros),
        bid: yield* numberToMicros(quote.bidPrice),
        ask: yield* numberToMicros(quote.askPrice),
        trade: yield* numberToMicros(trade.price),
      },
      state: {
        symbol,
        bars1m: bars.map(({ open, high, low, close, volume, vwap, tradeCount }, index) => ({
          minuteBeforeWindowEnd: 30 - index,
          open,
          high,
          low,
          close,
          volume,
          vwap,
          tradeCount,
        })),
        quote: {
          bid: quote.bidPrice,
          ask: quote.askPrice,
          bidSize: quote.bidSize,
          askSize: quote.askSize,
          ageMs: quoteAgeMs,
        },
        latestTrade: { price: trade.price, size: trade.size, ageMs: tradeAgeMs },
        rolling30m: {
          referencePrice: Number(values.referencePriceMicros) / 1_000_000,
          rangeHigh: Number(values.rangeHighPriceMicros) / 1_000_000,
          rangeLow: Number(values.rangeLowPriceMicros) / 1_000_000,
          totalVolume: Number(values.totalVolumeMicros) / 1_000_000,
        },
        returnsBps,
        minuteLogReturnVolatilityBps: volatilityBps,
        recent15mVolumeToPrior15m: earlyVolume === 0 ? null : recentVolume / earlyVolume,
        technicalIndicators: technicalValues,
        technicalAvailability: technical === undefined ? 'UNAVAILABLE' : 'RECORDED',
      },
    }
  })

export const jevTradingQuestions = {
  regime: {
    type: 'choice',
    instructions: {
      question:
        'Which current price-action regime best fits the candidate, considering its recent path, computed signals and benchmark context?',
      evidence: ['candidate', 'benchmark', 'relativeSignals'],
      uncertainty: 'Use unclear when the available evidence does not distinguish these regimes.',
    },
    criteria: {
      upward_trend: 'Broadly sustained upward movement, rather than a single isolated jump.',
      downward_trend: 'Broadly sustained downward movement, rather than a single isolated drop.',
      range: 'Mostly oscillating or balanced movement without sustained direction.',
      unstable: 'Abrupt or conflicting movements dominate.',
      unclear: 'Insufficient or conflicting evidence prevents classification.',
    },
  },
  continuation: {
    type: 'noul',
    instructions:
      'Does the combined candidate price path, volume, technical signals and benchmark context support sustained upward continuation over the stated horizon?',
    criteria: {
      true: 'The evidence supports an upward continuation setup.',
      false:
        'The evidence does not support upward continuation, including downtrend, exhaustion, contradictory signals or insufficient evidence.',
    },
  },
  exhaustion: {
    type: 'noul',
    instructions:
      'Does the candidate show a stretched or weakening upward move with meaningful reversal risk over the stated horizon? Evaluate the joint pattern rather than applying one indicator threshold.',
  },
  setup_quality: {
    type: 'score',
    instructions:
      'How coherent is the candidate long-entry setup across price action, volume, technical signals and benchmark context? Missing indicators provide no supporting evidence. Do not calculate sizing or treat this score as a return forecast.',
    criteria: [
      'No supported long setup',
      'Weak or contradictory setup',
      'Mixed but plausible setup',
      'Several signals support a coherent setup',
      'Strongly aligned evidence across the available signal groups',
    ],
  },
  action: {
    type: 'choice',
    instructions:
      'Given the candidate and benchmark trading signals, which long-only entry decision is best supported for the stated horizon? This question assesses the setup; deterministic code separately checks permission, sizing and risk.',
    criteria: {
      enter: 'Evidence supports entering a long position now.',
      wait: 'A possible setup needs further confirmation.',
      avoid: 'The setup is adverse, exhausted, contradictory or unsupported.',
    },
  },
} satisfies JevRequest['questions']

export const makeJevTradingSignalRequest = (
  snapshot: StrategyMarketSnapshot,
  symbol: string,
  benchmarkSymbol: string,
) =>
  Result.gen(function* () {
    if (symbol === benchmarkSymbol) return yield* unavailable('Candidate and benchmark must be distinct')
    const candidate = yield* signalFor(snapshot, symbol)
    const benchmark = yield* signalFor(snapshot, benchmarkSymbol)
    const { metrics } = yield* deriveIntradayMomentumSignalMetrics(candidate.prices, symbol, benchmark.prices)
    const session = snapshot.manifest.calendar.sessions.find((entry) => entry.date === snapshot.manifest.sessionDate)
    if (session === undefined) return yield* unavailable('Jev signal snapshot has no matching market session')
    const observed = Date.parse(snapshot.manifest.observedAt)
    return yield* prepareJevRequest({
      model: jevModel,
      state: {
        schemaVersion: 'bayn.jev-trading-signal-state.v1',
        task: {
          positionPolicy: 'long-only',
          horizonMinutes: 15,
          purpose:
            'Evaluate the supplied trading signals. No unreported outside facts or future observations are available.',
        },
        units: {
          prices: 'USD per share',
          volume: 'shares on the IEX feed',
          quoteSize: 'raw provider size units; not consolidated liquidity',
          returns: 'basis points, 100 bps = 1 percent',
          technicalPrices: 'USD per share',
          rsi14: 'RSI percentage points',
          realizedVolatility60ReturnsRatio: 'unannualized return ratio',
          rangeLocationPpm: '0 at rolling range low, 1000000 at rolling range high; bounded to this range',
        },
        session: {
          observedAt: snapshot.manifest.observedAt,
          completedBarWindowEndsAt: snapshot.manifest.rangeEndAt,
          completedBarWindowAgeMs: observed - Date.parse(snapshot.manifest.rangeEndAt),
          minutesSinceOpen: (observed - Date.parse(session.openAt)) / 60_000,
          minutesUntilClose: (Date.parse(session.closeAt) - observed) / 60_000,
          barIntervalMinutes: 1,
          feed: snapshot.manifest.feed,
          coverage: 'exchange-only; not the consolidated market',
        },
        candidate: candidate.state,
        benchmark: benchmark.state,
        relativeSignals: metrics,
      },
      questions: jevTradingQuestions,
    })
  })
