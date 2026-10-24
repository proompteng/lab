import { jevBatchQuestionSetHash } from './batch'
import { exchangeSessions } from '../market-hours'
import { jevBenchmarkSymbol, jevMarketForSymbol } from './markets'
import { isContinuousMarket } from '../market-hours'
import { rollingValues } from '../market-data/features/native-feature'
import { missingMinuteBars } from '../market-data/streaming/inputs'
import { isCryptoMarketFeature } from '../market-data/features/crypto-contract'
import { BigDecimal, Result } from 'effect'

import { numberToMicros, priceNumberToMicros, scaledNumber } from '../strategy/execution-model/fixed-point'
import {
  deriveIntradayBidBreakoutBps,
  deriveIntradayMomentumSignalMetrics,
} from '../strategy/intraday-momentum/decision-core'
import type { StrategyMarketSnapshot, VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'

import {
  IntradayBenchmarkEvidencePolicy,
  usesCompletedBarBenchmark,
  usesWindowTradeEvidence,
} from '../market-data/intraday/model'
import { intradayAgeNanos } from '../market-data/intraday/time'
import { canonicalHashV1Result } from '../hash'
import { JevContractError, jevModel, prepareJevRequest, type JevRequest } from './contract'
import {
  decodeJevBatchPlan,
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  JevEntryExclusion,
  makeJevBatchPlan,
} from './batch'
import { makeJevEvaluationRequest, type JevEvaluationRequest } from './evidence'
import { reproduceJevCandidateObservation } from './observation'
import { JevPurpose, type JevPortfolio } from './portfolio'
import type { JevProtocol } from './protocol'
import { jevEntryEconomics } from './entry-economics'
import { jevEntrySetupQuestion, jevTradePlanQuestion } from './trade-plan-choices'

const unavailable = (message: string) => Result.fail(new JevContractError({ message }))

const signalPriceMicros = (value: number, field: string) =>
  Result.gen(function* () {
    yield* numberToMicros(value, field)
    const rounded = BigDecimal.round(BigDecimal.fromNumberUnsafe(value), { scale: 6, mode: 'half-ceil' })
    return yield* scaledNumber(Number(BigDecimal.scale(rounded, 6).value), field, 1)
  })

export const jevEntryQuoteExclusion = (quote: NonNullable<StrategyMarketSnapshot['latestQuotes'][string]>) =>
  Result.gen(function* () {
    const bid = yield* priceNumberToMicros(quote.bidPrice, 'bid', 'DOWN')
    const ask = yield* priceNumberToMicros(quote.askPrice, 'ask', 'UP')
    if ((ask - bid) * 20_000n > BigInt(jevMarketForSymbol(quote.symbol).maximumEntrySpreadBps) * (ask + bid))
      return JevEntryExclusion.Spread
    if (quote.bidSize <= 0 || quote.askSize <= 0) return JevEntryExclusion.DisplayedSize
    return null
  })

const latestSignalTrade = (snapshot: StrategyMarketSnapshot, symbol: string) =>
  snapshot.trades
    .filter((entry) => entry.symbol === symbol)
    .toSorted((a, b) => a.eventAt.localeCompare(b.eventAt))
    .at(-1)

const pricingAgeMs = (snapshot: StrategyMarketSnapshot, eventAt: string) =>
  Number(intradayAgeNanos(snapshot.manifest.observedAt, eventAt)) / 1_000_000

export const jevStalePricingSymbols = (snapshot: VerifiedStrategyMarketSnapshot) =>
  snapshot.manifest.symbols.filter((symbol) => {
    if (snapshot.manifest.candidateExclusions?.some((entry) => entry.symbol === symbol) === true) return false
    if (usesCompletedBarBenchmark(snapshot.manifest, symbol)) return false
    const quote = snapshot.latestQuotes[symbol]
    const trade = latestSignalTrade(snapshot, symbol)
    const pricingEvidence = usesWindowTradeEvidence(snapshot.manifest, symbol) ? [quote] : [quote, trade]
    return pricingEvidence.some(
      (entry) => entry !== undefined && pricingAgeMs(snapshot, entry.eventAt) > snapshot.manifest.maximumQuoteAgeMs,
    )
  })

const jevBarSignalFor = (snapshot: StrategyMarketSnapshot, symbol: string) =>
  Result.gen(function* () {
    const manifest = snapshot.manifest
    const rolling = manifest.streaming.features.find((entry) => entry.value.material.symbol === symbol)
    const bars = snapshot.bars
      .filter((bar) => bar.symbol === symbol)
      .toSorted((a, b) => a.eventAt.localeCompare(b.eventAt))
    if (!manifest.symbols.includes(symbol) || rolling === undefined || bars.length === 0)
      return yield* unavailable('Jev benchmark requires verified rolling features and completed bars')
    const technical = manifest.streaming.technical?.features.find((entry) => entry.value.material.symbol === symbol)
    const recordedTechnicalValues = isCryptoMarketFeature(rolling.value)
      ? rolling.value.material.technical
      : technical?.value.material.values
    const technicalValues =
      recordedTechnicalValues === undefined
        ? null
        : Object.fromEntries(
            Object.entries(recordedTechnicalValues).map(([name, scalar]) => [
              name
                .replace(/PriceMicros$/, 'PriceUsd')
                .replace('rsi14Micros', 'rsi14')
                .replace('realizedVolatility60ReturnsPpm', 'realizedVolatility60ReturnsRatio'),
              { status: scalar.status, value: scalar.value === null ? null : Number(scalar.value) / 1_000_000 },
            ]),
          )
    const first = bars[0]
    const last = bars.at(-1)
    if (first === undefined || last === undefined) return yield* unavailable('Jev rolling signal window is empty')
    if (Date.parse(last.eventAt) !== Date.parse(manifest.rangeEndAt) - 60_000)
      return yield* unavailable('Jev signals require the latest completed minute')
    const returnsBps = Object.fromEntries(
      [1, 5, 15, 30].map((minutes) => {
        const referenceAt = Date.parse(manifest.rangeEndAt) - minutes * 60_000
        const reference = bars.find((bar) => Date.parse(bar.eventAt) === referenceAt)
        return [String(minutes), reference === undefined ? null : (last.close / reference.open - 1) * 10_000]
      }),
    )
    const midpoint = Date.parse(manifest.rangeEndAt) - 15 * 60_000
    const earlyBars = bars.filter((bar) => Date.parse(bar.eventAt) < midpoint)
    const recentBars = bars.filter((bar) => Date.parse(bar.eventAt) >= midpoint)
    const earlyVolume = earlyBars.reduce((total, bar) => total + bar.volume, 0)
    const recentVolume = recentBars.reduce((total, bar) => total + bar.volume, 0)
    const minuteReturns = bars.flatMap((bar, index) => {
      const previous = bars[index - 1]
      return previous !== undefined && Date.parse(bar.eventAt) - Date.parse(previous.eventAt) === 60_000
        ? [Math.log(bar.close / previous.close)]
        : []
    })
    const mean = minuteReturns.reduce((sum, value) => sum + value, 0) / minuteReturns.length
    const volatilityBps =
      minuteReturns.length === 0
        ? null
        : Math.sqrt(minuteReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / minuteReturns.length) * 10_000
    const values = rollingValues(rolling.value)
    return {
      prices: {
        reference: yield* signalPriceMicros(values.reference, 'signal reference'),
        high: yield* signalPriceMicros(values.high, 'signal high'),
        low: yield* signalPriceMicros(values.low, 'signal low'),
      },
      close: yield* signalPriceMicros(last.close, 'signal close'),
      state: {
        symbol,
        bars1m: bars.map(({ open, high, low, close, volume, vwap, tradeCount }, index) => ({
          minuteBeforeWindowEnd:
            (Date.parse(manifest.rangeEndAt) - Date.parse(bars[index]?.eventAt ?? first.eventAt)) / 60_000,
          open,
          high,
          low,
          close,
          volume,
          vwap,
          tradeCount,
        })),
        priceWindow: {
          contextStartAt: manifest.rangeStartAt,
          contextEndAt: manifest.rangeEndAt,
          referenceAt: first.eventAt,
          observedBarCount: bars.length,
          expectedBarCount: (Date.parse(manifest.rangeEndAt) - Date.parse(manifest.rangeStartAt)) / 60_000,
          missingMinuteAt: missingMinuteBars(bars, manifest.rangeStartAt, manifest.rangeEndAt),
          referencePrice: values.reference,
          rangeHigh: values.high,
          rangeLow: values.low,
          totalVolume: values.volume,
        },
        returnsBps,
        minuteLogReturnVolatilityBps: volatilityBps,
        recent15mVolumeToPrior15m:
          earlyBars.length !== 15 || recentBars.length !== 15 || earlyVolume === 0 ? null : recentVolume / earlyVolume,
        technicalIndicators: technicalValues,
        technicalAvailability: recordedTechnicalValues === undefined ? 'UNAVAILABLE' : 'RECORDED',
      },
    }
  })

export const jevSignalFor = (snapshot: StrategyMarketSnapshot, symbol: string) =>
  Result.gen(function* () {
    const manifest = snapshot.manifest
    if (manifest.candidateExclusions?.some((entry) => entry.symbol === symbol) === true)
      return yield* unavailable('Jev signal subject is excluded or outside the verified snapshot')
    const base = yield* jevBarSignalFor(snapshot, symbol)
    const quote = snapshot.latestQuotes[symbol]
    const trade = latestSignalTrade(snapshot, symbol)
    if (quote === undefined || trade === undefined)
      return yield* unavailable('Jev signals require the verified rolling window, quote and trade')
    const quoteAgeMs = pricingAgeMs(snapshot, quote.eventAt)
    const tradeAgeMs = pricingAgeMs(snapshot, trade.eventAt)
    const pricingAges = usesWindowTradeEvidence(manifest, symbol) ? [quoteAgeMs] : [quoteAgeMs, tradeAgeMs]
    if (tradeAgeMs < 0 || pricingAges.some((age) => age < 0 || age > manifest.maximumQuoteAgeMs))
      return yield* unavailable('Jev signal pricing evidence is stale or future dated')
    return {
      prices: {
        ...base.prices,
        bid: yield* priceNumberToMicros(quote.bidPrice, 'bid', 'DOWN'),
        ask: yield* priceNumberToMicros(quote.askPrice, 'ask', 'UP'),
        trade: yield* signalPriceMicros(trade.price, 'signal trade'),
      },
      state: {
        ...base.state,
        quote: {
          bid: quote.bidPrice,
          ask: quote.askPrice,
          bidSize: quote.bidSize,
          askSize: quote.askSize,
          ageMs: quoteAgeMs,
        },
        latestTrade: { price: trade.price, size: trade.size, ageMs: tradeAgeMs },
      },
    }
  })

export const jevBenchmarkSignalFor = (snapshot: StrategyMarketSnapshot, symbol: string) =>
  Result.gen(function* () {
    if (snapshot.manifest.benchmarkEvidencePolicy === IntradayBenchmarkEvidencePolicy.CompletedBars) {
      const base = yield* jevBarSignalFor(snapshot, symbol)
      return {
        prices: { reference: base.prices.reference, bid: base.close, ask: base.close },
        state: {
          ...base.state,
          pricingBasis: 'COMPLETED_BAR_CLOSE' as const,
          latestCompletedClose: Number(base.close) / 1_000_000,
        },
      }
    }
    return yield* jevSignalFor(snapshot, symbol)
  })

export const commonMomentumPrices = (
  snapshot: StrategyMarketSnapshot,
  symbol: string,
  benchmarkSymbol: string,
  candidate: Result.Result.Success<ReturnType<typeof jevSignalFor>>,
  benchmark: Result.Result.Success<ReturnType<typeof jevBenchmarkSignalFor>>,
) =>
  Result.gen(function* () {
    const candidateBars = snapshot.bars
      .filter((bar) => bar.symbol === symbol)
      .toSorted((a, b) => a.eventAt.localeCompare(b.eventAt))
    const benchmarkBars = snapshot.bars.filter((bar) => bar.symbol === benchmarkSymbol)
    const reference = candidateBars.find((bar) => benchmarkBars.some((entry) => entry.eventAt === bar.eventAt))
    const benchmarkReference = benchmarkBars.find((bar) => bar.eventAt === reference?.eventAt)
    if (reference === undefined || benchmarkReference === undefined)
      return yield* unavailable('Relative momentum requires a common actual observed minute')
    const completedBars = snapshot.manifest.benchmarkEvidencePolicy === IntradayBenchmarkEvidencePolicy.CompletedBars
    const candidatePrices = {
      ...candidate.prices,
      reference: yield* signalPriceMicros(reference.open, 'signal reference'),
    }
    const benchmarkPrices = {
      ...benchmark.prices,
      reference: yield* signalPriceMicros(benchmarkReference.open, 'signal reference'),
    }
    if (!completedBars)
      return {
        referenceAt: reference.eventAt,
        comparisonAt: snapshot.manifest.observedAt,
        pricingBasis: 'CURRENT_QUOTES' as const,
        candidate: candidatePrices,
        benchmark: benchmarkPrices,
      }
    const latestMinute = Date.parse(snapshot.manifest.rangeEndAt) - 60_000
    const candidateClose = candidateBars.find((bar) => Date.parse(bar.eventAt) === latestMinute)
    const benchmarkClose = benchmarkBars.find((bar) => Date.parse(bar.eventAt) === latestMinute)
    if (candidateClose === undefined || benchmarkClose === undefined)
      return yield* unavailable('Relative momentum requires the same completed ending minute')
    const candidateClosingPrice = yield* signalPriceMicros(candidateClose.close, 'relative candidate close')
    const benchmarkClosingPrice = yield* signalPriceMicros(benchmarkClose.close, 'relative benchmark close')
    return {
      referenceAt: reference.eventAt,
      comparisonAt: snapshot.manifest.rangeEndAt,
      pricingBasis: 'COMPLETED_BAR_CLOSE' as const,
      candidate: {
        ...candidatePrices,
        bid: candidateClosingPrice,
        ask: candidateClosingPrice,
        trade: candidateClosingPrice,
      },
      benchmark: {
        ...benchmarkPrices,
        bid: benchmarkClosingPrice,
        ask: benchmarkClosingPrice,
      },
    }
  })

export const jevManagementQuestions = {
  action: {
    type: 'choice',
    instructions:
      'Given `candidate`, `benchmark`, `relativeSignals` and the held long `position`, does the current market evidence support continuation over `position.remainingHoldingMinutes`, or does deterioration support exiting now? Judge the future setup from the supplied signals. Code separately enforces sizing, fees, protective stops and the holding deadline. Assess the evidence without assuming that a prior entry was correct.',
    criteria: {
      hold: 'Continuation is supported by the current evidence over the remaining holding horizon.',
      exit: 'Deteriorating, exhausted or contradictory current evidence supports closing the long.',
      unclear: 'The evidence does not distinguish holding from exiting.',
    },
  },
} satisfies JevRequest['questions']

const requestFromSnapshot = (
  snapshot: StrategyMarketSnapshot,
  symbol: string,
  benchmarkSymbol: string,
  native: { readonly protocol: JevProtocol; readonly portfolio: JevPortfolio },
) =>
  Result.gen(function* () {
    if (symbol === benchmarkSymbol) return yield* unavailable('Candidate and benchmark must be distinct')
    const candidate = yield* jevSignalFor(snapshot, symbol)
    const benchmark = yield* jevBenchmarkSignalFor(snapshot, benchmarkSymbol)
    const common = yield* commonMomentumPrices(snapshot, symbol, benchmarkSymbol, candidate, benchmark)
    const { metrics } = yield* deriveIntradayMomentumSignalMetrics(common.candidate, symbol, common.benchmark)
    const { metrics: currentPriceMetrics } = yield* deriveIntradayMomentumSignalMetrics(
      { ...candidate.prices, reference: common.candidate.reference },
      symbol,
      { ...benchmark.prices, reference: common.benchmark.reference },
    )
    const continuous = isContinuousMarket(snapshot.manifest.calendar)
    const session = continuous
      ? undefined
      : exchangeSessions(snapshot.manifest.calendar).find((entry) => entry.date === snapshot.manifest.sessionDate)
    if (!continuous && session === undefined)
      return yield* unavailable('Jev signal snapshot has no matching market session')
    const observed = Date.parse(snapshot.manifest.observedAt)
    let position = null
    if (native.portfolio.purpose === JevPurpose.Manage) {
      const held = native.portfolio.brokerState.positions.find(
        (entry) => entry.symbol === symbol && BigInt(entry.quantityAtoms) > 0n,
      )
      const firstFill = native.portfolio.entryFills[0]
      if (held === undefined || firstFill === undefined || BigInt(held.costBasisMicros) <= 0n)
        return yield* unavailable('Jev management requires the actual long, cost basis and entry fills')
      const heldForMinutes = (observed - Date.parse(firstFill.occurredAt)) / 60_000
      position = {
        symbol,
        quantityUnits: Number(held.quantityAtoms) / 1_000_000_000,
        entryFilledAt: firstFill.occurredAt,
        heldForMinutes,
        maximumHoldingMinutes: native.protocol.maximumHoldingMinutes,
        remainingHoldingMinutes: Math.max(0, native.protocol.maximumHoldingMinutes - heldForMinutes),
      }
    }
    const economics =
      native.portfolio.purpose === JevPurpose.Entry
        ? yield* jevEntryEconomics({
            protocol: native.protocol,
            symbol,
            bidMicros: candidate.prices.bid,
            askMicros: candidate.prices.ask,
            capitalMicros: native.portfolio.brokerState.account.equityMicros,
          })
        : null
    return yield* prepareJevRequest({
      model: jevModel,
      state: {
        schemaVersion: native.protocol.inputDefinition,
        task: {
          positionPolicy: 'long-only',
          horizonMinutes: native.protocol.horizonMinutes,
          decisionPurpose: native.portfolio.purpose,
          purpose:
            'Evaluate the supplied trading signals. No unreported outside facts or future observations are available.',
        },
        position,
        entryEconomics: economics,
        execution: {
          orderType: 'LIMIT',
          timeInForce: continuous ? 'IOC' : 'DAY',
          extendedHours: !continuous,
          sizingPolicy: native.protocol.entrySizingPolicy,
          maximumEntrySpreadBps: jevMarketForSymbol(symbol).maximumEntrySpreadBps,
          estimatedFeeBpsPerSide: jevMarketForSymbol(symbol).estimatedTakerFeeBps,
          estimatedRoundTripFeesBps: 2 * jevMarketForSymbol(symbol).estimatedTakerFeeBps,
        },
        units: {
          prices: 'USD per unit',
          volume: continuous ? 'base asset units on Alpaca crypto US' : 'shares on the IEX feed',
          quoteSize: 'raw provider size units; not consolidated liquidity',
          ...(usesWindowTradeEvidence(snapshot.manifest, symbol)
            ? { latestTrade: 'last actual trade since lookback start; ageMs is contextual, not an executable price' }
            : {}),
          returns: 'basis points, 100 bps = 1 percent',
          technicalPrices: 'USD per unit',
          rsi14: 'RSI percentage points',
          realizedVolatility60ReturnsRatio: 'unannualized return ratio',
          rangeLocationPpm: '0 at rolling range low, 1000000 at rolling range high; bounded to this range',
        },
        session: {
          observedAt: snapshot.manifest.observedAt,
          completedBarWindowEndsAt: snapshot.manifest.rangeEndAt,
          completedBarWindowAgeMs: observed - Date.parse(snapshot.manifest.rangeEndAt),
          schedule: continuous ? 'CONTINUOUS' : 'SESSIONS',
          minutesSinceOpen: session === undefined ? null : (observed - Date.parse(session.openAt)) / 60_000,
          minutesUntilClose: session === undefined ? null : (Date.parse(session.closeAt) - observed) / 60_000,
          barIntervalMinutes: 1,
          feed: snapshot.manifest.feed,
          coverage: continuous ? 'Alpaca crypto US venue' : 'exchange-only; not the consolidated market',
        },
        candidate: {
          ...candidate.state,
          currentPriceSignals: {
            lookbackReturnBps: currentPriceMetrics.lookbackReturnBps,
            breakoutBps: usesWindowTradeEvidence(snapshot.manifest, symbol)
              ? yield* deriveIntradayBidBreakoutBps(candidate.prices, symbol)
              : currentPriceMetrics.breakoutBps,
            breakoutPricingBasis: usesWindowTradeEvidence(snapshot.manifest, symbol)
              ? 'CURRENT_BID'
              : 'CURRENT_ASK_AND_FRESH_TRADE',
            spreadBps: currentPriceMetrics.spreadBps,
            rangeLocationPpm: currentPriceMetrics.rangeLocationPpm,
            referenceAt: common.referenceAt,
            observedAt: snapshot.manifest.observedAt,
            lookbackMinutes: (observed - Date.parse(common.referenceAt)) / 60_000,
          },
        },
        benchmark: benchmark.state,
        relativeSignals: {
          lookbackReturnBps: metrics.lookbackReturnBps,
          benchmarkReturnBps: metrics.benchmarkReturnBps,
          excessReturnBps: metrics.excessReturnBps,
          pricingBasis: common.pricingBasis,
          referenceAt: common.referenceAt,
          comparisonAt: common.comparisonAt,
          lookbackMinutes: (Date.parse(common.comparisonAt) - Date.parse(common.referenceAt)) / 60_000,
          candidateReferencePriceUsd: Number(common.candidate.reference) / 1_000_000,
          benchmarkReferencePriceUsd: Number(common.benchmark.reference) / 1_000_000,
        },
      },
      questions:
        native.portfolio.purpose === JevPurpose.Manage
          ? jevManagementQuestions
          : {
              action: yield* jevTradePlanQuestion({ snapshot, symbol, economics, protocol: native.protocol }),
              setup: jevEntrySetupQuestion,
            },
    })
  })

export const makeJevTradingSignalRequest = (input: unknown, symbol: string) =>
  reproduceJevCandidateObservation(input).pipe(
    Result.flatMap((observation) =>
      requestFromSnapshot(observation.snapshot, symbol, jevBenchmarkSymbol(symbol), observation),
    ),
  )

export const reproduceJevRequestFromObservation = (request: JevEvaluationRequest, input: unknown) =>
  reproduceJevCandidateObservation(input).pipe(
    Result.flatMap((observation) => reproduceJevRequestFromVerifiedObservation(request, observation)),
  )

export const reproduceJevRequestFromVerifiedObservation = (
  request: JevEvaluationRequest,
  observation: Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>>,
) =>
  Result.gen(function* () {
    if (
      request.cycleId !== observation.cycleId ||
      request.authorityGenerationHash !== observation.authorityGenerationHash ||
      request.snapshotId !== observation.snapshot.manifest.snapshotId ||
      request.observedAt !== observation.observedAt ||
      !observation.protocol.candidateSymbols.includes(request.symbol)
    )
      return yield* unavailable('Jev request does not belong to its reproduced observation')
    const prepared = yield* requestFromSnapshot(
      observation.snapshot,
      request.symbol,
      jevBenchmarkSymbol(request.symbol),
      observation,
    )
    if (prepared.requestHash !== request.requestHash)
      return yield* unavailable('Jev request payload differs from the reproduced trading signals and questions')
    return prepared
  })

const batchFromObservation = (
  observation: Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>>,
  expiresAt: string,
  planVersion: JevBatchPlanVersion,
) =>
  Result.gen(function* () {
    const { snapshot, protocol } = observation
    const manifest = snapshot.manifest
    if (planVersion !== JevBatchPlanVersion.V6)
      return yield* unavailable('The current trading protocol requires batch v6')
    if (Date.parse(expiresAt) !== Date.parse(observation.observedAt) + protocol.inferenceValidityMs)
      return yield* unavailable('Jev batch deadline must equal its source-controlled validity interval')
    if (manifest.candidateSymbols === undefined || manifest.candidateSymbols.length === 0)
      return yield* unavailable('Jev batch requires the complete recorded candidate universe')
    const candidates = []
    for (const symbol of manifest.candidateSymbols) {
      const excluded = manifest.candidateExclusions?.find((candidate) => candidate.symbol === symbol)
      if (excluded !== undefined) {
        candidates.push({ ...excluded, status: JevCandidatePlanStatus.Excluded })
        continue
      }
      const benchmarkExclusion = manifest.candidateExclusions?.find(
        (candidate) => candidate.symbol === jevBenchmarkSymbol(symbol),
      )
      if (
        benchmarkExclusion !== undefined &&
        (snapshot.manifest.benchmarkEvidencePolicy !== IntradayBenchmarkEvidencePolicy.CompletedBars ||
          Result.isFailure(jevBenchmarkSignalFor(snapshot, jevBenchmarkSymbol(symbol))))
      ) {
        candidates.push({
          symbol,
          status: JevCandidatePlanStatus.Excluded,
          reason: benchmarkExclusion.reason,
          message: `Required benchmark ${benchmarkExclusion.symbol}: ${benchmarkExclusion.message}`,
        })
        continue
      }
      const prepared = yield* requestFromSnapshot(snapshot, symbol, jevBenchmarkSymbol(symbol), observation)
      if (observation.portfolio.purpose === JevPurpose.Entry) {
        const quote = snapshot.latestQuotes[symbol]
        if (quote !== undefined) {
          const entryExclusion = yield* jevEntryQuoteExclusion(quote)
          if (entryExclusion !== null) {
            candidates.push({
              symbol,
              status: JevCandidatePlanStatus.Excluded,
              reason: entryExclusion,
              message:
                entryExclusion === JevEntryExclusion.Spread
                  ? 'Verified entry quote exceeds the maximum spread'
                  : 'Verified entry quote has no two-sided displayed size',
            })
            continue
          }
        }
      }
      const request = yield* makeJevEvaluationRequest({
        schemaVersion: 'bayn.jev-evaluation-request.v1',
        cycleId: observation.cycleId,
        authorityGenerationHash: observation.authorityGenerationHash,
        snapshotId: manifest.snapshotId,
        symbol,
        observedAt: manifest.observedAt,
        expiresAt,
        requestHash: prepared.requestHash,
        request: prepared.request,
      })
      candidates.push({ symbol, status: JevCandidatePlanStatus.Requested, request })
    }
    return yield* makeJevBatchPlan({
      schemaVersion: planVersion,
      cycleId: observation.cycleId,
      authorityGenerationHash: observation.authorityGenerationHash,
      observationHash: observation.contentHash,
      protocolHash: yield* canonicalHashV1Result(protocol).pipe(
        Result.mapError((cause) => new JevContractError({ message: 'Jev source protocol cannot be hashed', cause })),
      ),
      snapshotId: manifest.snapshotId,
      observedAt: manifest.observedAt,
      expiresAt,
      benchmarkSymbol: jevBenchmarkSymbol(manifest.candidateSymbols[0] ?? 'SPY'),
      questionSetHash: yield* jevBatchQuestionSetHash(candidates),
      candidates,
    })
  })

export const makeJevTradingSignalBatch = (input: {
  readonly observation: unknown
  readonly expiresAt: string
  readonly planVersion: JevBatchPlanVersion
}) =>
  reproduceJevCandidateObservation(input.observation).pipe(
    Result.flatMap((observation) => batchFromObservation(observation, input.expiresAt, input.planVersion)),
  )

export const reproduceJevTradingSignalBatchEvidence = (inputObservation: unknown, input: unknown) =>
  Result.gen(function* () {
    const plan = yield* decodeJevBatchPlan(input)
    const observation = yield* reproduceJevCandidateObservation(inputObservation)
    const reproduced = yield* batchFromObservation(observation, plan.expiresAt, plan.schemaVersion)
    if (reproduced.batchId !== plan.batchId)
      return yield* unavailable('Jev batch requests or candidate universe differ from the reproduced source')
    return { observation, plan: reproduced }
  })

export const reproduceJevTradingSignalBatch = (observation: unknown, input: unknown) =>
  reproduceJevTradingSignalBatchEvidence(observation, input).pipe(Result.map(({ plan }) => plan))
