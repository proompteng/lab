import { expect, test } from 'bun:test'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import {
  AccountStatus,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
  type Fill,
  type Order,
  type Position,
} from '../../execution/contracts'
import type { EquityShortEligibility } from '../../execution/equity-short'
import { canonicalHashV1Result } from '../../hash'
import { makeIntradayAlphaRuntime } from '../../intraday-replay/strategy'
import { JevClient, JevError, type JevInference } from '../../jev/client'
import { JevFailure } from '../../jev/contract'
import { JevExitReason, decideJevExit } from '../../jev/exit'
import {
  JevPortfolioSchema,
  JevPurpose,
  currentProtectionEvidenceVersion,
  decodeJevPortfolio,
} from '../../jev/portfolio'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../../jev/protocol'
import { compileJevEntry } from '../../jev/runtime'
import {
  MarketFeatureContract,
  MarketFeatureDefinition,
  MarketFeatureSessionPolicy,
  decodeRollingMarketFeature,
  featureBarContentHash,
} from '../../market-data/features/contract'
import { type IntradayBar, type IntradayQuote, type IntradayTrade } from '../../market-data/intraday/model'
import { intradayInstantNanos } from '../../market-data/intraday/time'
import { KafkaBootstrapTimestampPolicy } from '../../market-data/streaming/bootstrap'
import {
  emptyStreamingProjection,
  incorporateMarketRecord,
  incorporateRecordedMarketValue,
} from '../../market-data/streaming/projection'
import { constructStreamingSnapshot } from '../../market-data/streaming/snapshot'
import { CandidateObservationStore } from '../../observe-composition/candidate-observation'
import { prepareObserveStartup } from '../../observe-composition/startup'
import { IsoDateSchema, strictParseOptions } from '../../schemas'
import { reconciledStateHash } from '../../simulation-reconciliation/broker-model'
import { numberToMicros, priceNumberToMicros } from '../execution-model/fixed-point'
import { intradayMomentumFeatureTopic } from '../intraday-momentum/protocol'
import { TargetPlanStatus, planTargets, quoteBoundTargetPlannerInputSchemaVersion } from '../../target-planner/index'
import { fixtureRuntime } from '../../testing/runtime-fixtures'
import { utcInstantFromEpochMillis } from '../../time'
import { evaluateCatalystVetos } from './catalyst-veto'
import { IntradayAlphaDecisionReason, IntradayAlphaTargetSchema, decideIntradayAlphaEntry } from './decision'
import { makeOwnedIntradayAlphaObservation, reproduceIntradayAlphaObservation } from './observation'
import {
  IntradayAlphaPhase,
  IntradayAlphaSetup,
  decodeIntradayAlphaPolicy,
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaEquityMarketProfile,
  intradayAlphaStrategyIdentity,
  makeIntradayAlphaPolicy,
} from './policy'
import { evaluateIntradayAlphaFromSnapshot, makeIntradayAlphaEntryQuery } from './runtime'
import {
  alphaQuoteSpreadAcceptable,
  computeObservedSessionVwap,
  computeOpeningRange,
  extractIntradayAlphaCandidates,
  selectIntradayAlphaLegs,
} from './signals'

const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)('2026-09-04')
const calendar = Result.getOrThrow(
  normalizeMarketCalendarResult(
    [{ session_open: '0930', session_close: '1600', date: '2026-09-04', open: '09:30', close: '16:00' }],
    { start: '2026-09-04', end: '2026-09-04' },
  ),
)
const sessionOpenMs = Date.parse('2026-09-04T13:30:00.000Z') // 09:30 EDT
const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const policy = makeIntradayAlphaPolicy(protocol)
const accountId = 'alpha-test-account'
const cycleId = '1'.repeat(64)
const authorityGenerationHash = '2'.repeat(64)

const makeFlatPortfolio = (observedAt: string, equityMicros = '100000000000', buyingPowerMicros = equityMicros) => {
  const material = {
    account: {
      schemaVersion: 'bayn.paper-account-snapshot.v2' as const,
      accountId,
      status: AccountStatus.Active,
      currency: 'USD' as const,
      cashMicros: equityMicros,
      buyingPowerMicros,
      equityMicros,
      cryptoFeeTier: null,
      observedAt,
    },
    positions: [] as const,
    positionsObservedAt: observedAt,
    orders: [] as const,
    ordersObservedAt: observedAt,
    accountingHash: 'd'.repeat(64),
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(material))
  const reconciliationMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: observedAt,
  }
  const reconciliationId = Result.getOrThrow(canonicalHashV1Result(reconciliationMaterial))
  const contentHash = Result.getOrThrow(canonicalHashV1Result({ ...reconciliationMaterial, reconciliationId }))
  return Result.getOrThrow(
    decodeJevPortfolio({
      purpose: JevPurpose.Entry,
      brokerState: {
        ...material,
        unknownOrderCount: 0,
        reconciliation: {
          ...reconciliationMaterial,
          reconciliationId,
          contentHash,
        },
      },
    }),
  )
}

const makeShortEligibility = (
  symbols: readonly string[],
  observedAt: string,
  shortableSymbols: ReadonlySet<string> = new Set(symbols),
): Readonly<Record<string, EquityShortEligibility>> =>
  Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      {
        schemaVersion: 'bayn.equity-short-eligibility.v1' as const,
        accountId,
        symbol,
        accountHash: 'a'.repeat(64),
        configurationHash: 'b'.repeat(64),
        assetHash: 'c'.repeat(64),
        accountObservedAt: observedAt,
        configurationObservedAt: observedAt,
        assetObservedAt: observedAt,
        accountActive: true,
        shortingEnabled: true,
        noShorting: false,
        assetActive: true,
        tradable: true,
        marginable: true,
        shortable: shortableSymbols.has(symbol),
        easyToBorrow: shortableSymbols.has(symbol),
      },
    ]),
  )

interface BarProfile {
  readonly basePrice: number
  readonly endReturnBps: number
  readonly gapMinutes?: readonly number[]
  readonly spreadBps?: number
  readonly overrideLatestClose?: number
  readonly overridePrevClose?: number
  readonly openingRangeHigh?: number
  readonly openingRangeLow?: number
}

/**
 * Constructs a genuine cryptographically verified full-session StreamingVerifiedMarketSnapshot
 * spanning [09:30 ET, rangeEndAt) with real PT30M Flink rolling feature receipts and SPY CompletedBars.
 */
const makeAlphaStreamingSnapshot = (input: {
  readonly minutesFromOpen: number // rangeEndAt = sessionOpen + minutesFromOpen * 60_000 (last bar is minutesFromOpen - 1)
  readonly profiles: Readonly<Record<string, BarProfile>>
  readonly spyProfile?: BarProfile
}) => {
  const rangeEndMs = sessionOpenMs + input.minutesFromOpen * 60_000
  const observedAtMs = rangeEndMs + protocol.decisionDelaySeconds * 1000
  const observedAt = utcInstantFromEpochMillis(observedAtMs)
  const rangeStartAt = utcInstantFromEpochMillis(sessionOpenMs)
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndMs)
  const market = intradayAlphaEquityMarketProfile
  const symbols = [...new Set([...intradayAlphaCandidateSymbols, intradayAlphaBenchmarkSymbol])].sort()

  const universe = {
    universeId: market.universeId,
    universeSymbolHash: market.universeSymbolHash,
    symbols: market.universe,
    feed: market.feed,
    delayClass: market.delayClass,
    topics: { ...market.sourceTopics, features: intradayMomentumFeatureTopic },
  }

  let barOffset = 0
  let quoteOffset = 0
  let tradeOffset = 0
  const bars: IntradayBar[] = []
  const quotes: IntradayQuote[] = []
  const trades: IntradayTrade[] = []

  const defaultSpy: BarProfile = input.spyProfile ?? { basePrice: 550, endReturnBps: 0 }

  for (const symbol of symbols) {
    const profile: BarProfile =
      symbol === intradayAlphaBenchmarkSymbol
        ? defaultSpy
        : (input.profiles[symbol] ?? { basePrice: 120, endReturnBps: 0 })
    const gapSet = new Set(profile.gapMinutes ?? [])
    const totalSteps = Math.max(1, input.minutesFromOpen - 1)

    let lastClose = profile.basePrice
    for (let m = 0; m < input.minutesFromOpen; m++) {
      if (gapSet.has(m) && m !== input.minutesFromOpen - 1) continue
      const barTime = utcInstantFromEpochMillis(sessionOpenMs + m * 60_000)
      const ingestedAt = utcInstantFromEpochMillis(sessionOpenMs + (m + 1) * 60_000 - 1_000)
      const frac = m / totalSteps
      let close = Number((profile.basePrice * (1 + (profile.endReturnBps / 10_000) * frac)).toFixed(2))
      if (m === input.minutesFromOpen - 2 && profile.overridePrevClose !== undefined) close = profile.overridePrevClose
      if (m === input.minutesFromOpen - 1 && profile.overrideLatestClose !== undefined)
        close = profile.overrideLatestClose
      const open = m === 0 ? profile.basePrice : lastClose
      let high = Number((Math.max(open, close) * 1.0005).toFixed(2))
      let low = Number((Math.min(open, close) * 0.9995).toFixed(2))
      if (m < 30) {
        if (profile.openingRangeHigh !== undefined) high = Math.max(high, profile.openingRangeHigh)
        if (profile.openingRangeLow !== undefined) low = Math.min(low, profile.openingRangeLow)
      }
      const vwap = Number(((open + high + low + close) / 4).toFixed(4))
      lastClose = close
      bars.push({
        provider: 'alpaca',
        universeId: market.universeId,
        universeSymbolHash: market.universeSymbolHash,
        marketSession: 'regular',
        schemaVersion: 1,
        channel: 'bars',
        final: true,
        symbol,
        eventAt: barTime,
        ingestedAt,
        feed: market.feed,
        delayClass: market.delayClass,
        sourceTopic: market.sourceTopics.bars,
        sourcePartition: 0,
        sourceOffset: String(barOffset++),
        open,
        high,
        low,
        close,
        volume: 15_000,
        vwap,
        tradeCount: '150',
      })
    }

    // Candidate quotes & trades (benchmark SPY uses CompletedBars so does not need quotes/trades, though adding trade is harmless)
    if (symbol !== intradayAlphaBenchmarkSymbol) {
      const spreadBps = profile.spreadBps ?? 6
      const halfSpread = (lastClose * (spreadBps / 10_000)) / 2
      const bidPrice = Number((lastClose - halfSpread).toFixed(2))
      const askPrice = Number(Math.max(bidPrice + 0.01, lastClose + halfSpread).toFixed(2))
      const quoteTime = utcInstantFromEpochMillis(observedAtMs - 1_000)
      quotes.push({
        provider: 'alpaca',
        universeId: market.universeId,
        universeSymbolHash: market.universeSymbolHash,
        marketSession: 'regular',
        schemaVersion: 1,
        symbol,
        eventAt: quoteTime,
        ingestedAt: quoteTime,
        feed: market.feed,
        delayClass: market.delayClass,
        sourceTopic: market.sourceTopics.quotes,
        sourcePartition: 0,
        sourceOffset: String(quoteOffset++),
        bidPrice,
        bidSize: 5_000,
        askPrice,
        askSize: 5_000,
      })
      trades.push({
        provider: 'alpaca',
        universeId: market.universeId,
        universeSymbolHash: market.universeSymbolHash,
        marketSession: 'regular',
        schemaVersion: 1,
        symbol,
        eventAt: quoteTime,
        ingestedAt: quoteTime,
        feed: market.feed,
        delayClass: market.delayClass,
        sourceTopic: market.sourceTopics.trades,
        sourcePartition: 0,
        sourceOffset: String(tradeOffset++),
        price: lastClose,
        size: 500,
      })
    }
  }

  let projection = emptyStreamingProjection('alpha-test-epoch')
  for (const record of [...bars, ...quotes, ...trades]) {
    projection = incorporateRecordedMarketValue(projection, record, universe, observedAtMs)
  }

  // Rolling PT30M features match the last 30m suffix [max(rangeEndMs - 30m, sessionOpenMs), rangeEndMs)
  const featureWindowStartMs = Math.max(rangeEndMs - 30 * 60_000, sessionOpenMs)
  let featureOffset = 0
  for (const symbol of symbols) {
    const windowBars = bars.filter(
      (bar) =>
        bar.symbol === symbol &&
        Date.parse(bar.eventAt) >= featureWindowStartMs &&
        Date.parse(bar.eventAt) < rangeEndMs,
    )
    if (windowBars.length === 0) continue
    const material = {
      schemaVersion: MarketFeatureContract.V1,
      definitionId: MarketFeatureDefinition.ObservedPriceWindow,
      definitionHash: market.streamingInput.requiredDefinitionHash,
      provider: 'alpaca' as const,
      feed: 'iex' as const,
      delayClass: 'real_time_exchange_only' as const,
      universeId: market.universeId,
      universeSymbolHash: market.universeSymbolHash,
      symbol,
      sessionDate,
      sessionPolicy: MarketFeatureSessionPolicy.IexClockSegments,
      windowStartMs: featureWindowStartMs,
      windowEndMs: rangeEndMs,
      inputs: windowBars.map((bar) => ({
        eventTimeNanos: intradayInstantNanos(bar.eventAt).toString(),
        ingestionTimeNanos: intradayInstantNanos(bar.ingestedAt).toString(),
        sourceTopic: bar.sourceTopic,
        sourcePartition: bar.sourcePartition,
        sourceOffset: bar.sourceOffset,
        contentHash: Result.getOrThrow(featureBarContentHash(bar)),
      })),
      values: {
        referencePriceMicros: Result.getOrThrow(numberToMicros(windowBars[0]?.open ?? 0, 'open')).toString(),
        rangeHighPriceMicros: Result.getOrThrow(
          numberToMicros(Math.max(...windowBars.map((bar) => bar.high)), 'high'),
        ).toString(),
        rangeLowPriceMicros: Result.getOrThrow(
          numberToMicros(Math.min(...windowBars.map((bar) => bar.low)), 'low'),
        ).toString(),
        lastClosePriceMicros: Result.getOrThrow(numberToMicros(windowBars.at(-1)?.close ?? 0, 'close')).toString(),
        totalVolumeMicros: Result.getOrThrow(
          numberToMicros(
            windowBars.reduce((sum, bar) => sum + bar.volume, 0),
            'vol',
          ),
        ).toString(),
      },
    }
    const feature = Result.getOrThrow(
      decodeRollingMarketFeature({
        material,
        featureId: Result.getOrThrow(canonicalHashV1Result(material)),
        computedAtMs: observedAtMs,
        producerRevision: 'alpha-test-flink',
      }),
    )
    projection = incorporateMarketRecord(
      projection,
      {
        topic: intradayMomentumFeatureTopic,
        partition: 0,
        offset: String(featureOffset++),
        value: JSON.stringify(feature),
      },
      universe,
      observedAtMs,
    )
  }

  const positions = Object.values(universe.topics)
    .sort()
    .map((topic) => ({
      topic,
      partition: 0,
      offset: String(BigInt(projection.offsets.get(`${topic}:0`) ?? '-1') + 1n),
    }))

  const cut = {
    projection,
    consumerSequence: bars.length + quotes.length + trades.length + featureOffset,
    positions,
    deliveredPositions: positions,
    bootstrap: {
      schemaVersion: 'bayn.kafka-bootstrap.v1' as const,
      epoch: projection.epoch,
      observedAtMs: observedAtMs - 1_000,
      lowerTimestampMs: sessionOpenMs - 5_000,
      timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
      partitions: positions.map((position) => ({
        topic: position.topic,
        partition: position.partition,
        logStartOffset: '0',
        startOffset: '0',
        endOffset: position.offset,
      })),
    },
  }

  const query = Result.getOrThrow(makeIntradayAlphaEntryQuery({ policy, calendar, sessionDate, observedAtMs }))
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, query))
  return { snapshot, observedAt, observedAtMs, rangeStartAt, rangeEndAt, query }
}

test('gap-resilient session VWAP and 30m Opening Range handle silent IEX minutes accurately', () => {
  // Simulate COHR with 4 missing morning minutes (where Flink recursive VWAP returns GAP)
  const { snapshot } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121, // 11:30 completed bar -> rangeEnd 11:31
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -250, gapMinutes: [5, 17, 42, 88] },
    },
  })
  const cohrBars = snapshot.bars.filter((bar) => bar.symbol === 'COHR')
  expect(cohrBars.length).toBe(117)
  const vwap = computeObservedSessionVwap(cohrBars, sessionOpenMs, Date.parse(snapshot.manifest.rangeEndAt))
  expect(vwap).not.toBeNull()
  expect(vwap ?? 0).toBeGreaterThan(97)
  expect(vwap ?? 0).toBeLessThan(100.5)

  const orb = computeOpeningRange(cohrBars, sessionOpenMs, 30, 24)
  expect(orb).not.toBeNull()
  expect(orb?.barCount).toBe(28)
})

test('25 bps IEX spread cap passes realistic 15 bps equity quotes and blocks 30 bps quotes', () => {
  expect(
    Result.getOrThrow(
      alphaQuoteSpreadAcceptable({ bidPrice: 100.0, askPrice: 100.15, bidSize: 200, askSize: 200 }, 25),
    ),
  ).toBe(true)
  expect(
    Result.getOrThrow(
      alphaQuoteSpreadAcceptable({ bidPrice: 100.0, askPrice: 100.32, bidSize: 200, askSize: 200 }, 25),
    ),
  ).toBe(false)
})

test('Phase 2 Morning ORB30 selects aligned Long breakout, enforces hold cap before 11:28 ET, and respects re-entry limits', () => {
  // Minute 40 from open (10:10 ET): rangeEnd = 10:11 ET -> completedMinuteFromOpen = 40
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 41,
    spyProfile: { basePrice: 550, endReturnBps: 45 }, // SPY > session VWAP
    profiles: {
      NVDA: {
        basePrice: 140,
        endReturnBps: 40,
        openingRangeHigh: 141.0,
        openingRangeLow: 139.0,
        overridePrevClose: 140.9,
        overrideLatestClose: 141.65,
        spreadBps: 14, // passes 25 bps cap (would have starved at v44's 5 bps!)
      },
      AMD: {
        basePrice: 160,
        endReturnBps: 30,
        openingRangeHigh: 161.0,
        openingRangeLow: 159.0,
        overridePrevClose: 160.8,
        overrideLatestClose: 161.2,
        spreadBps: 35, // blocked by 25 bps cap
      },
    },
  })
  const portfolio = makeFlatPortfolio(observedAt)
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      equityShortEligibility: eligibility,
    }),
  )
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v1',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  expect(target.phase).toBe(IntradayAlphaPhase.MorningOrb)
  expect(target.reason).toBe(IntradayAlphaDecisionReason.SelectedMorningOrb)
  expect(target.selectedSymbols).toEqual(['NVDA'])
  expect(target.targetWeights['NVDA']).toBe(0.2)
  const nvdaPlan = target.exitPolicy.plans['NVDA']
  expect(nvdaPlan?.schemaVersion).toBe('bayn.intraday-alpha-long-funded-exit-plan.v1')
  expect(nvdaPlan?.levels.maximumHoldingMinutes).toBe(45)
  expect(Result.isSuccess(Schema.decodeUnknownResult(IntradayAlphaTargetSchema, strictParseOptions)(target))).toBe(true)

  // Re-entry blocked when NVDA already taken or maxTradesPerSession (2) reached
  const blockedSame = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v1',
        observation: owned.payload,
        morningOrbTakenSymbols: ['NVDA'],
        middayReversionCompleted: false,
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )
  expect(blockedSame.selectedSymbols).toEqual([])
  expect(blockedSame.reason).toBe(IntradayAlphaDecisionReason.NoSignal)

  // Late morning entry (minute 75 = 10:45 ET): hold must be capped at 118 - 76 = 42 minutes (< 45)
  const late = makeAlphaStreamingSnapshot({
    minutesFromOpen: 76,
    spyProfile: { basePrice: 550, endReturnBps: 50 },
    profiles: {
      NVDA: {
        basePrice: 140,
        endReturnBps: 45,
        openingRangeHigh: 141.0,
        openingRangeLow: 139.0,
        overridePrevClose: 140.95,
        overrideLatestClose: 141.7,
      },
    },
  })
  const lateExtracted = Result.getOrThrow(
    extractIntradayAlphaCandidates({
      snapshot: late.snapshot,
      policy,
      accountId,
      equityShortEligibility: makeShortEligibility(intradayAlphaCandidateSymbols, late.observedAt),
    }),
  )
  const lateLegs = selectIntradayAlphaLegs({
    context: lateExtracted.context,
    policy,
    longPool: lateExtracted.longPool,
    shortPool: lateExtracted.shortPool,
    vetoedSymbols: new Set(),
  })
  expect(lateLegs[0]?.symbol).toBe('NVDA')
  expect(lateLegs[0]?.maximumHoldingMinutes).toBe(42)
})

test('Phase 2 Morning ORB30 selects Short breakdown with short exit plan when SPY < VWAP and borrowable', () => {
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 36, // 10:05 ET completed
    spyProfile: { basePrice: 550, endReturnBps: -55 }, // SPY < session VWAP
    profiles: {
      MU: {
        basePrice: 110,
        endReturnBps: -60,
        openingRangeHigh: 110.5,
        openingRangeLow: 109.2,
        overridePrevClose: 109.25,
        overrideLatestClose: 108.6,
      },
    },
  })
  const portfolio = makeFlatPortfolio(observedAt)
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      equityShortEligibility: eligibility,
    }),
  )
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v1',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  expect(target.selectedSymbols).toEqual(['MU'])
  expect(target.targetWeights['MU']).toBe(-0.2)
  expect(target.exitPolicy.plans['MU']?.schemaVersion).toBe('bayn.intraday-alpha-short-funded-exit-plan.v1')
  expect(target.exitPolicy.plans['MU']?.levels.source.setup).toBe(IntradayAlphaSetup.Orb30Short)
})

test('Phase 1 Midday Reversion selects 2L + 2S dollar-neutral portfolio, falls through catalyst vetos, and plans 4 legs inside $100k cash BP', () => {
  // Minute 120 from open (11:30 ET completed -> rangeEnd 11:31 ET)
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 10 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -420, gapMinutes: [12, 44] }, // #1 oversold (will test veto fall-through)
      LITE: { basePrice: 90, endReturnBps: -310 }, // #2 oversold -> Long
      WDC: { basePrice: 70, endReturnBps: -220 }, // #3 oversold -> Long (on COHR veto)
      SNDK: { basePrice: 60, endReturnBps: 380 }, // #1 overbought -> Short
      CRDO: { basePrice: 80, endReturnBps: 290 }, // #2 overbought -> Short
      MRVL: { basePrice: 85, endReturnBps: 180 }, // #3 overbought
    },
  })
  const portfolio = makeFlatPortfolio(observedAt, '100000000000', '100000000000') // exact 1x $100k cash account
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      equityShortEligibility: eligibility,
    }),
  )
  // Verify cryptographic observation reproduction round-trip!
  const reproducedObs = Result.getOrThrow(reproduceIntradayAlphaObservation(owned.payload))
  expect(reproducedObs.contentHash).toBe(owned.contentHash)

  // 1) Normal 2L + 2S selection without vetos -> Long COHR, LITE + Short SNDK, CRDO
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v1',
        observation: owned.payload,
        morningOrbTakenSymbols: ['NVDA'],
        middayReversionCompleted: false,
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  expect(target.phase).toBe(IntradayAlphaPhase.MiddayReversion)
  expect(target.reason).toBe(IntradayAlphaDecisionReason.SelectedMiddayReversion)
  expect(target.selectedSymbols).toEqual(['COHR', 'CRDO', 'LITE', 'SNDK'])
  expect(target.targetWeights['COHR']).toBe(0.18)
  expect(target.targetWeights['LITE']).toBe(0.18)
  expect(target.targetWeights['CRDO']).toBe(-0.18)
  expect(target.targetWeights['SNDK']).toBe(-0.18)
  expect(Result.isSuccess(Schema.decodeUnknownResult(IntradayAlphaTargetSchema, strictParseOptions)(target))).toBe(true)

  // 2) Run actual production compileJevEntry + target-planner planTargets on the 4-leg (2L + 2S) target!
  const compiled = Result.getOrThrow(compileJevEntry(target, snapshot, snapshot))
  const priceMicros: Record<string, string> = {}
  const bidPriceMicros: Record<string, string> = {}
  const askPriceMicros: Record<string, string> = {}
  for (const symbol of Object.keys(compiled.planningTargetWeights ?? {})) {
    const q = snapshot.latestQuotes[symbol]
    if (q === undefined) continue
    priceMicros[symbol] =
      compiled.priceMicros[symbol] ?? Result.getOrThrow(priceNumberToMicros(q.askPrice, 'p', 'UP')).toString()
    bidPriceMicros[symbol] =
      compiled.bidPriceMicros?.[symbol] ?? Result.getOrThrow(priceNumberToMicros(q.bidPrice, 'b', 'DOWN')).toString()
    askPriceMicros[symbol] =
      compiled.askPriceMicros?.[symbol] ?? Result.getOrThrow(priceNumberToMicros(q.askPrice, 'a', 'UP')).toString()
  }
  const refMaterial = {
    schemaVersion: 'bayn.intraday-snapshot-reference-prices.v1' as const,
    snapshotId: snapshot.manifest.snapshotId,
    snapshotContentHash: snapshot.manifest.contentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    signalDate: sessionDate,
    observedAt: snapshot.manifest.observedAt,
    priceMicros,
    bidPriceMicros,
    askPriceMicros,
  }
  const refHash = Result.getOrThrow(canonicalHashV1Result(refMaterial))
  const planned = Result.getOrThrow(
    planTargets({
      schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
      strategyName: 'jev',
      cycleId,
      decisionHash: '3'.repeat(64),
      policyHash: '4'.repeat(64),
      accountId,
      signalDate: sessionDate,
      targetWeights: compiled.planningTargetWeights ?? target.targetWeights,
      referencePrices: { ...refMaterial, contentHash: refHash },
      brokerState: portfolio.brokerState,
      precision: protocol.executionModel.precision,
      allocationCapitalMicros: portfolio.brokerState.account.equityMicros,
      maximumInputAgeMs: 60_000,
      submissionCutoffAt: utcInstantFromEpochMillis(Date.parse(observedAt) + 60_000),
      observedAt,
      executionTerms: {
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        priceReference: 'verified-adverse-quote-boundary',
        snapshotId: snapshot.manifest.snapshotId,
        snapshotContentHash: snapshot.manifest.contentHash,
        maximumBuyQuantityAtoms: compiled.maximumBuyQuantityAtoms,
        maximumSellQuantityAtoms: compiled.maximumSellQuantityAtoms,
        equityShortEntries: Object.fromEntries(
          ['CRDO', 'SNDK'].map((symbol) => [symbol, eligibility[symbol]]).filter((entry) => entry[1] !== undefined),
        ),
      },
    }),
  )
  // Proves 2L + 2S at 18% per leg (36% Long + 54% Short collateral = 90% BP) plans with ZERO InsufficientBuyingPower!
  expect(planned.status).toBe(TargetPlanStatus.Planned)
  expect(planned.intentTargets.length).toBe(4)
  expect(
    planned.intentTargets
      .filter((intent) => intent.side === OrderSide.Buy)
      .map((i) => i.symbol)
      .sort(),
  ).toEqual(['COHR', 'LITE'])
  expect(
    planned.intentTargets
      .filter((intent) => intent.side === OrderSide.Sell)
      .map((i) => i.symbol)
      .sort(),
  ).toEqual(['CRDO', 'SNDK'])

  // 3) Catalyst veto on #1 oversold (COHR) cleanly falls through to #3 (WDC) instead of starving!
  const withVeto = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v1',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        catalystVetos: [
          {
            symbol: 'COHR',
            phase: IntradayAlphaPhase.MiddayReversion,
            direction: 'LONG',
            status: 'ASSESSED',
            requestHash: '5'.repeat(64),
            responseHash: '6'.repeat(64),
            vetoProbability: 0.94,
            vetoed: true,
            recordedAt: observedAt,
          },
        ],
        decidedAt: observedAt,
      },
      policy,
    ),
  )
  expect(withVeto.selectedSymbols).toEqual(['CRDO', 'LITE', 'SNDK', 'WDC'])

  // 4) Single-extreme anti-starvation fallback if zero equities are shortable
  const longOnlyEligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt, new Set())
  const longOnlyOwned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio,
      snapshot,
      equityShortEligibility: longOnlyEligibility,
    }),
  )
  const fallbackTarget = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v1',
        observation: longOnlyOwned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )
  expect(fallbackTarget.selectedSymbols).toEqual(['COHR'])
  expect(fallbackTarget.targetWeights['COHR']).toBe(0.2)
})

test('catalyst veto fails open to quant signal on JevClient outage instead of starving entries', async () => {
  const { snapshot, observedAt, rangeEndAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 0 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -350 },
      LITE: { basePrice: 90, endReturnBps: -280 },
      SNDK: { basePrice: 60, endReturnBps: 340 },
      CRDO: { basePrice: 80, endReturnBps: 250 },
    },
  })
  const portfolio = makeFlatPortfolio(observedAt)
  const eligibility = makeShortEligibility(intradayAlphaCandidateSymbols, observedAt)
  const recorded: string[] = []
  const failingJevClient = Layer.succeed(JevClient, {
    evaluate: () =>
      Effect.fail(
        new JevError({
          failure: JevFailure.Transport,
          message: 'TypeSafe provider unreachable',
        }),
      ),
  })
  const obsStore = Layer.succeed(CandidateObservationStore, {
    record: (obs) =>
      Effect.sync(() => {
        recorded.push(obs.contentHash)
      }),
    latestJevWindowEnd: () => Effect.succeed(Option.none()),
    readIntradayAlphaSessionState: () =>
      Effect.succeed({ morningOrbTakenSymbols: [], middayReversionCompleted: false }),
  })

  // Test direct fail-open veto evaluation
  const receipts = await Effect.runPromise(
    evaluateCatalystVetos({
      candidates: [
        {
          model: policy.catalystVeto.model,
          symbol: 'COHR',
          phase: IntradayAlphaPhase.MiddayReversion,
          direction: 'LONG',
          windowEndAt: rangeEndAt,
          sessionOpenPrice: 100,
          sessionVwap: 98.5,
          latestClose: 96.5,
          relVwapDevBps: -200,
          recentBars: snapshot.bars
            .filter((b) => b.symbol === 'COHR')
            .slice(-5)
            .map(({ eventAt, open, high, low, close, volume }) => ({ eventAt, open, high, low, close, volume })),
        },
      ],
      vetoThreshold: 0.85,
      budgetMs: 5_000,
      recordedAt: observedAt,
    }).pipe(Effect.provide(failingJevClient)),
  )
  expect(receipts[0]?.status).toBe('UNAVAILABLE')
  expect(receipts[0]?.vetoed).toBe(false)

  // Test full runtime evaluation: records observation durably and selects all 4 legs despite JevClient outage!
  const evaluated = await Effect.runPromise(
    TestClock.setTime(Date.parse(observedAt)).pipe(
      Effect.andThen(
        evaluateIntradayAlphaFromSnapshot({
          observation: {
            cycleId,
            authorityGenerationHash,
            protocol,
            portfolio,
            equityShortEligibility: eligibility,
          },
          rangeEndAt,
          loadSnapshot: Effect.succeed(snapshot),
          policy,
          admissionExpiresAt: Date.parse(observedAt) + 60_000,
        }),
      ),
      Effect.provide(Layer.mergeAll(failingJevClient, obsStore, TestClock.layer())),
    ),
  )
  expect(recorded.length).toBe(1)
  expect(evaluated.decision.selectedSymbols).toEqual(['COHR', 'CRDO', 'LITE', 'SNDK'])
  expect(evaluated.decision.evidence.catalystVetos.every((v) => v.status === 'UNAVAILABLE' && !v.vetoed)).toBe(true)

  // Also test JevClient returning high probability (>= 0.85) for COHR -> vetoes COHR cleanly!
  const vetoingJevClient = Layer.succeed(JevClient, {
    evaluate: (req) => {
      const isCohr = JSON.stringify(req).includes('"COHR"')
      const inference: JevInference = {
        requestHash: '7'.repeat(64),
        responseHash: '8'.repeat(64),
        startedAt: observedAt,
        completedAt: observedAt,
        response: {
          model: policy.catalystVeto.model,
          answers: {
            catalyst_dislocation_veto: {
              type: 'noul',
              noul: isCohr ? 0.92 : 0.12,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }
      return Effect.succeed(inference)
    },
  })
  const vetoedEval = await Effect.runPromise(
    TestClock.setTime(Date.parse(observedAt)).pipe(
      Effect.andThen(
        evaluateIntradayAlphaFromSnapshot({
          observation: {
            cycleId,
            authorityGenerationHash,
            protocol,
            portfolio,
            equityShortEligibility: eligibility,
          },
          rangeEndAt,
          loadSnapshot: Effect.succeed(snapshot),
          policy,
          admissionExpiresAt: Date.parse(observedAt) + 60_000,
        }),
      ),
      Effect.provide(Layer.mergeAll(vetoingJevClient, obsStore, TestClock.layer())),
    ),
  )
  expect(vetoedEval.decision.selectedSymbols).not.toContain('COHR')
  expect(vetoedEval.decision.selectedSymbols.length).toBe(4)
})

test('multi-position (2L + 2S) JevPortfolio validates 4 legs, partial early leg close, and per-symbol MaximumHold exit', () => {
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 0 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -350 },
      LITE: { basePrice: 90, endReturnBps: -280 },
      SNDK: { basePrice: 60, endReturnBps: 340 },
      CRDO: { basePrice: 80, endReturnBps: 250 },
    },
  })
  const flatPortfolio = makeFlatPortfolio(observedAt)
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId,
      authorityGenerationHash,
      protocol,
      portfolio: flatPortfolio,
      snapshot,
      equityShortEligibility: makeShortEligibility(intradayAlphaCandidateSymbols, observedAt),
    }),
  )
  const target = Result.getOrThrow(
    decideIntradayAlphaEntry(
      {
        schemaVersion: 'bayn.intraday-alpha-evidence.v1',
        observation: owned.payload,
        morningOrbTakenSymbols: [],
        middayReversionCompleted: false,
        catalystVetos: [],
        decidedAt: observedAt,
      },
      policy,
    ),
  )

  // Construct a reconciled MANAGE portfolio holding 3 of the 4 legs (1 leg SNDK already closed via native profit target)
  const fillTime = observedAt
  const entryIntentIds = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)]
  const fills: Fill[] = [
    {
      schemaVersion: 'bayn.fill.v2',
      accountId,
      fillId: 'f1',
      brokerOrderId: 'o1',
      clientOrderId: 'c1',
      intentId: entryIntentIds[0],
      symbol: 'COHR',
      side: OrderSide.Buy,
      quantityAtoms: '100000000000', // 100 sh
      priceAtoms: '96500000000',
      feeMicros: '0',
      occurredAt: fillTime,
    },
    {
      schemaVersion: 'bayn.fill.v2',
      accountId,
      fillId: 'f2',
      brokerOrderId: 'o2',
      clientOrderId: 'c2',
      intentId: entryIntentIds[1],
      symbol: 'LITE',
      side: OrderSide.Buy,
      quantityAtoms: '100000000000',
      priceAtoms: '87480000000',
      feeMicros: '0',
      occurredAt: fillTime,
    },
    {
      schemaVersion: 'bayn.fill.v2',
      accountId,
      fillId: 'f3',
      brokerOrderId: 'o3',
      clientOrderId: 'c3',
      intentId: entryIntentIds[2],
      symbol: 'CRDO',
      side: OrderSide.Sell,
      quantityAtoms: '100000000000',
      priceAtoms: '82000000000',
      feeMicros: '0',
      occurredAt: fillTime,
    },
  ]
  const checkTime = utcInstantFromEpochMillis(
    Date.parse(fillTime) + target.exitPolicy.maximumHoldingMinutes * 60_000 + 1_000,
  )
  const positions: Position[] = [
    {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol: 'COHR',
      quantityAtoms: '100000000000',
      averageEntryPriceMicros: '96500000',
      costBasisMicros: '9650000000',
      marketPriceMicros: '97000000',
      marketValueMicros: '9700000000',
      unrealizedPnlMicros: '50000000',
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol: 'CRDO',
      quantityAtoms: '-100000000000',
      averageEntryPriceMicros: '82000000',
      costBasisMicros: '-8200000000',
      marketPriceMicros: '81000000',
      marketValueMicros: '-8100000000',
      unrealizedPnlMicros: '100000000',
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.position.v2',
      accountId,
      symbol: 'LITE',
      quantityAtoms: '100000000000',
      averageEntryPriceMicros: '87480000',
      costBasisMicros: '8748000000',
      marketPriceMicros: '88000000',
      marketValueMicros: '8800000000',
      unrealizedPnlMicros: '52000000',
      observedAt: checkTime,
    },
  ]
  const orders: Order[] = [
    {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: 'o1',
      clientOrderId: 'c1',
      intentId: entryIntentIds[0],
      symbol: 'COHR',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '100000000000',
      filledQuantityAtoms: '100000000000',
      limitPriceMicros: '96500000',
      status: OrderStatus.Filled,
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: 'o2',
      clientOrderId: 'c2',
      intentId: entryIntentIds[1],
      symbol: 'LITE',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '100000000000',
      filledQuantityAtoms: '100000000000',
      limitPriceMicros: '87480000',
      status: OrderStatus.Filled,
      observedAt: checkTime,
    },
    {
      schemaVersion: 'bayn.order.v3',
      accountId,
      brokerOrderId: 'o3',
      clientOrderId: 'c3',
      intentId: entryIntentIds[2],
      symbol: 'CRDO',
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '100000000000',
      filledQuantityAtoms: '100000000000',
      limitPriceMicros: '82000000',
      status: OrderStatus.Filled,
      observedAt: checkTime,
    },
  ]
  const brokerMaterial = {
    account: { ...flatPortfolio.brokerState.account, observedAt: checkTime },
    positions,
    positionsObservedAt: checkTime,
    orders,
    ordersObservedAt: checkTime,
    accountingHash: 'd'.repeat(64),
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(brokerMaterial))
  const recMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: checkTime,
  }
  const recId = Result.getOrThrow(canonicalHashV1Result(recMaterial))
  const recHash = Result.getOrThrow(canonicalHashV1Result({ ...recMaterial, reconciliationId: recId }))
  const managePortfolio = Result.getOrThrow(
    Schema.decodeUnknownResult(
      JevPortfolioSchema,
      strictParseOptions,
    )({
      purpose: JevPurpose.Manage,
      protectionEvidenceVersion: currentProtectionEvidenceVersion,
      brokerState: {
        ...brokerMaterial,
        unknownOrderCount: 0,
        reconciliation: { ...recMaterial, reconciliationId: recId, contentHash: recHash },
      },
      entryDecisionHash: '9'.repeat(64),
      exitPolicy: target.exitPolicy,
      entryIntentIds,
      protectionIntentIds: [],
      exitRequestedAt: null,
      profitExitRequested: false,
      protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' },
      entryInventoryDebit: { quantityAtoms: '0', costBasisMicros: '0' },
      entryFills: fills,
    }),
  )

  // Per-symbol MaximumHold exit on Short leg CRDO succeeds cleanly!
  const crdoExit = Result.getOrThrow(
    decideJevExit({
      cycleId,
      sessionDate,
      protocol,
      portfolio: managePortfolio,
      observedAt: checkTime,
      symbol: 'CRDO',
      trigger: { reason: JevExitReason.MaximumHold },
    }),
  )
  expect(crdoExit.symbols).toEqual(['CRDO'])
  expect(crdoExit.reason).toBe(JevExitReason.MaximumHold)
  expect(crdoExit.targetWeights).toEqual({ CRDO: 0 })

  // Per-symbol MaximumHold exit on Long leg COHR succeeds independently as well!
  const cohrExit = Result.getOrThrow(
    decideJevExit({
      cycleId,
      sessionDate,
      protocol,
      portfolio: managePortfolio,
      observedAt: checkTime,
      symbol: 'COHR',
      trigger: { reason: JevExitReason.MaximumHold },
    }),
  )
  expect(cohrExit.symbols).toEqual(['COHR'])
  expect(cohrExit.reason).toBe(JevExitReason.MaximumHold)
  expect(cohrExit.targetWeights).toEqual({ COHR: 0 })

  // And before MaximumHold due time, decideJevPositionHold holds cleanly without exiting!
  const earlyCheckTime = utcInstantFromEpochMillis(Date.parse(fillTime) + 10_000)
  const earlyPositions = positions.map((p) => ({ ...p, observedAt: earlyCheckTime }))
  const earlyOrders = orders.map((o) => ({ ...o, observedAt: earlyCheckTime }))
  const earlyBrokerMaterial = {
    account: { ...flatPortfolio.brokerState.account, observedAt: earlyCheckTime },
    positions: earlyPositions,
    positionsObservedAt: earlyCheckTime,
    orders: earlyOrders,
    ordersObservedAt: earlyCheckTime,
    accountingHash: 'd'.repeat(64),
  }
  const earlyStateHash = Result.getOrThrow(reconciledStateHash(earlyBrokerMaterial))
  const earlyRecMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: earlyStateHash,
    observedHash: earlyStateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [] as const,
    reconciledAt: earlyCheckTime,
  }
  const earlyRecId = Result.getOrThrow(canonicalHashV1Result(earlyRecMaterial))
  const earlyRecHash = Result.getOrThrow(canonicalHashV1Result({ ...earlyRecMaterial, reconciliationId: earlyRecId }))
  const earlyPortfolio = Result.getOrThrow(
    Schema.decodeUnknownResult(
      JevPortfolioSchema,
      strictParseOptions,
    )({
      purpose: JevPurpose.Manage,
      protectionEvidenceVersion: currentProtectionEvidenceVersion,
      brokerState: {
        ...earlyBrokerMaterial,
        unknownOrderCount: 0,
        reconciliation: { ...earlyRecMaterial, reconciliationId: earlyRecId, contentHash: earlyRecHash },
      },
      entryDecisionHash: '9'.repeat(64),
      exitPolicy: target.exitPolicy,
      entryIntentIds,
      protectionIntentIds: [],
      exitRequestedAt: null,
      profitExitRequested: false,
      protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' },
      entryInventoryDebit: { quantityAtoms: '0', costBasisMicros: '0' },
      entryFills: fills,
    }),
  )
  // Before MaximumHold due time, decideJevExit refuses premature MaximumHold exit on COHR!
  const prematureExit = decideJevExit({
    cycleId,
    sessionDate,
    protocol,
    portfolio: earlyPortfolio,
    observedAt: earlyCheckTime,
    symbol: 'COHR',
    trigger: { reason: JevExitReason.MaximumHold },
  })
  expect(Result.isFailure(prematureExit)).toBe(true)
})

test('intraday alpha policy identity and native startup preparation bind distinct protocol hash', () => {
  const identity = Result.getOrThrow(intradayAlphaStrategyIdentity(policy))
  expect(identity.strategy.parameterSchemaVersion).toBe('bayn.intraday-alpha-policy.v1')
  expect(identity.strategy.parameterHash).toBe(Result.getOrThrow(canonicalHashV1Result(policy)))
  expect(Result.isFailure(decodeIntradayAlphaPolicy({ ...policy, candidateSymbols: ['AAPL'] }))).toBe(true)

  const strategy = makeIntradayAlphaRuntime(policy, { ...fixtureRuntime.provenance, strategy: identity.strategy })
  const prepared = Result.getOrThrow(
    prepareObserveStartup({
      strategy,
      accountId,
      authorityGenerationHash,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
    }),
  )
  expect(prepared.strategyProtocolHash).toBe(identity.protocolHash)
})
