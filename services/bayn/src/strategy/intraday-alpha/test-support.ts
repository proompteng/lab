import { Result, Schema } from 'effect'
import { AccountStatus, ReconciliationStatus } from '../../execution/contracts'
import { decodeJevPortfolio, JevPurpose } from '../../jev/portfolio'
import { reconciledStateHash } from '../../simulation-reconciliation/broker-model'
import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import { canonicalHashV1Result } from '../../hash'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../../jev/protocol'
import {
  MarketFeatureContract,
  MarketFeatureDefinition,
  MarketFeatureSessionPolicy,
  decodeRollingMarketFeature,
  featureBarContentHash,
} from '../../market-data/features/contract'
import type { IntradayBar, IntradayQuote, IntradayTrade } from '../../market-data/intraday/model'
import {
  intradayAlphaTrailingBaselineSchemaVersion,
  noiseAreaCheckpointMinutes,
  type IntradayAlphaTrailingBaseline,
} from '../../market-data/intraday/trailing-baseline'
import { intradayInstantNanos } from '../../market-data/intraday/time'
import { KafkaBootstrapTimestampPolicy } from '../../market-data/streaming/bootstrap'
import {
  emptyStreamingProjection,
  incorporateMarketRecord,
  incorporateRecordedMarketValue,
} from '../../market-data/streaming/projection'
import { constructStreamingSnapshot } from '../../market-data/streaming/snapshot'
import { IsoDateSchema } from '../../schemas'
import { utcInstantFromEpochMillis } from '../../time'
import { numberToMicros } from '../execution-model/fixed-point'
import { intradayMomentumFeatureTopic } from '../intraday-momentum/protocol'
import {
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaEquityMarketProfile,
  makeIntradayAlphaPolicy,
  makePureEtfPolicy,
} from './policy'
import { makeIntradayAlphaEntryQuery } from './runtime'

const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)('2026-09-04')
const calendar = Result.getOrThrow(
  normalizeMarketCalendarResult(
    [{ session_open: '0930', session_close: '1600', date: '2026-09-04', open: '09:30', close: '16:00' }],
    { start: '2026-09-04', end: '2026-09-04' },
  ),
)
const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const policy = makeIntradayAlphaPolicy(protocol)

export const makeFlatAlphaPortfolio = (
  observedAt: string,
  equityMicros = '100000000000',
  buyingPowerMicros = equityMicros,
  accountId = 'alpha-test-account',
) => {
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

export const makeTestTrailingBaseline = (
  overrides?: Readonly<
    Record<
      string,
      {
        readonly prevClose?: number
        readonly atr14Ratio?: number
        readonly avgSwingByCheckpoint?: Readonly<Record<string, number>>
      }
    >
  >,
): IntradayAlphaTrailingBaseline => ({
  schemaVersion: intradayAlphaTrailingBaselineSchemaVersion,
  sessionDate,
  lookbackSessions: 14,
  latestPriorSessionDate: Schema.decodeUnknownSync(IsoDateSchema)('2026-09-03'),
  symbols: Object.fromEntries(
    intradayAlphaCandidateSymbols.map((symbol) => {
      const custom = overrides?.[symbol]
      const isNoise = policy.noiseAreaSymbols.includes(symbol)
      return [
        symbol,
        {
          priorSessions: 14,
          prevClose: custom?.prevClose ?? (symbol === 'QQQ' ? 500 : symbol === 'SMH' ? 250 : 140),
          atr14Ratio: custom?.atr14Ratio ?? (symbol === 'QQQ' ? 0.014 : symbol === 'SMH' ? 0.024 : 0.04),
          ...(isNoise
            ? {
                avgSwingByCheckpoint:
                  custom?.avgSwingByCheckpoint ??
                  Object.fromEntries(
                    noiseAreaCheckpointMinutes.map((cp) => [String(cp), symbol === 'QQQ' ? 0.004 : 0.006]),
                  ),
              }
            : {}),
        },
      ]
    }),
  ),
})

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
export const makeAlphaStreamingSnapshot = (input: {
  readonly minutesFromOpen: number // rangeEndAt = sessionOpen + minutesFromOpen * 60_000 (last bar is minutesFromOpen - 1)
  readonly profiles: Readonly<Record<string, BarProfile>>
  readonly spyProfile?: BarProfile
  readonly quoteSpreadBps?: number
  readonly quoteBidSize?: number
  readonly quoteAskSize?: number
  readonly pureEtf?: boolean
  readonly prematureSymbol?: string
  readonly snapshotCalendar?: typeof calendar
}) => {
  const activePolicy = input.pureEtf === true ? makePureEtfPolicy(protocol) : policy
  const effectiveCalendar = input.snapshotCalendar ?? calendar
  const session = effectiveCalendar.providerSessions[0]
  if (session === undefined) throw new Error('Expected a fixture session')
  const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)(session.date)
  const sessionOpenMs = Date.parse(session.regularOpenAt)
  const rangeEndMs = sessionOpenMs + input.minutesFromOpen * 60_000
  const observedAtMs = rangeEndMs + protocol.decisionDelaySeconds * 1000
  const observedAt = utcInstantFromEpochMillis(observedAtMs)
  const rangeStartAt = utcInstantFromEpochMillis(sessionOpenMs)
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndMs)
  const market = intradayAlphaEquityMarketProfile
  const symbols = [...activePolicy.candidateSymbols, intradayAlphaBenchmarkSymbol].sort()

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
      const ingestedAt = utcInstantFromEpochMillis(
        sessionOpenMs +
          (m + 1) * 60_000 -
          (input.pureEtf !== true || (symbol === input.prematureSymbol && m === input.minutesFromOpen - 1) ? 1_000 : 0),
      )
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
      const spreadBps = profile.spreadBps ?? input.quoteSpreadBps ?? 6
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
        bidSize: input.quoteBidSize ?? 5_000,
        askPrice,
        askSize: input.quoteAskSize ?? 5_000,
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

  const query = Result.getOrThrow(
    makeIntradayAlphaEntryQuery({ policy: activePolicy, calendar: effectiveCalendar, sessionDate, observedAtMs }),
  )
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, query))
  return { snapshot, cut, observedAt, observedAtMs, rangeStartAt, rangeEndAt, query }
}
