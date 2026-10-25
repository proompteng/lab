import { Result } from 'effect'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { IntradayBenchmarkEvidencePolicy } from '../market-data/intraday/model'
import { deriveIntradayMomentumSignalMetrics } from '../strategy/intraday-momentum/decision-core'
import { jevBenchmarkSymbol } from '../jev/markets'
import { JevContractError } from '../jev/contract'
import {
  jevSignalFor,
  jevBenchmarkSignalFor,
  commonMomentumPrices,
  jevEntryQuoteExclusion,
} from '../jev/trading-signals'
const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

/** Candidate and benchmark returns use the same actual observed reference minute. */
export const momentumControlCandidates = (snapshot: StrategyMarketSnapshot) =>
  Result.gen(function* () {
    const signals = []
    for (const symbol of snapshot.manifest.candidateSymbols ?? []) {
      if (
        snapshot.manifest.candidateExclusions?.some(
          (entry) =>
            entry.symbol === symbol ||
            (entry.symbol === jevBenchmarkSymbol(symbol) &&
              snapshot.manifest.benchmarkEvidencePolicy !== IntradayBenchmarkEvidencePolicy.CompletedBars),
        ) === true
      )
        continue
      const candidate = yield* jevSignalFor(snapshot, symbol)
      const benchmarkResult = jevBenchmarkSignalFor(snapshot, jevBenchmarkSymbol(symbol))
      if (Result.isFailure(benchmarkResult)) return yield* Result.fail(benchmarkResult.failure)
      const benchmark = benchmarkResult.success
      const common = yield* commonMomentumPrices(snapshot, symbol, jevBenchmarkSymbol(symbol), candidate, benchmark)
      const { excessReturn } = yield* deriveIntradayMomentumSignalMetrics(common.candidate, symbol, common.benchmark)
      const quote = snapshot.latestQuotes[symbol]
      if (quote === undefined) return yield* unavailable('Momentum candidate has no verified quote')
      if (
        (yield* jevEntryQuoteExclusion(quote)) === null &&
        common.candidate.bid + common.candidate.ask > 2n * common.candidate.reference &&
        excessReturn.numerator > 0n
      )
        signals.push({ symbol, excessReturn })
    }
    return signals.sort((a, b) => {
      const difference =
        a.excessReturn.numerator * b.excessReturn.denominator - b.excessReturn.numerator * a.excessReturn.denominator
      return difference === 0n ? a.symbol.localeCompare(b.symbol) : difference > 0n ? -1 : 1
    })
  })
