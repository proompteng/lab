import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import technicalFixture from '../market-data/features/fixtures/technical-indicators-v1.json'
import { decodeTechnicalMarketFeature, TechnicalReadiness } from '../market-data/features/technical-contract'
import { featureBarContentHash } from '../market-data/features/contract'
import { canonicalHashV1 } from '../hash'
import { incorporateMarketRecord } from '../market-data/streaming/projection'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { makeJevTradingSignalRequest } from './trading-signals'
import { decodeJevResponse, jevModel, prepareJevRequest } from './contract'

const snapshotWithTechnical = () => {
  const { snapshot, cut, query, protocol } = streamingFixture()
  const rolling = snapshot.manifest.streaming.features.find((entry) => entry.value.material.symbol === 'AAPL')
  const first = snapshot.bars.find((bar) => bar.symbol === 'AAPL')
  const session = snapshot.manifest.calendar.sessions[0]
  if (rolling === undefined || first === undefined || session === undefined) throw new Error('Missing signal fixture')
  const open = Date.parse(session.openAt)
  const olderInputs = Array.from({ length: 30 }, (_, index) => {
    const event = open + index * 60_000,
      ingested = event + 61_000
    const bar = {
      ...first,
      eventAt: new Date(event).toISOString(),
      ingestedAt: new Date(ingested).toISOString(),
      sourceOffset: String(10000 + index),
    }
    return {
      eventTimeNanos: String(BigInt(event) * 1_000_000n),
      ingestionTimeNanos: String(BigInt(ingested) * 1_000_000n),
      sourceTopic: bar.sourceTopic,
      sourcePartition: bar.sourcePartition,
      sourceOffset: bar.sourceOffset,
      contentHash: Result.getOrThrow(featureBarContentHash(bar)),
    }
  })
  const material = {
    ...technicalFixture.material,
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    sessionDate: query.sessionDate,
    windowStartMs: open,
    windowEndMs: Date.parse(query.rangeEndAt),
    inputs: [...olderInputs, ...rolling.value.material.inputs],
    values: {
      ...technicalFixture.material.values,
      ema12PriceMicros: { status: TechnicalReadiness.Ready, value: '123450000' },
      rsi14Micros: { status: TechnicalReadiness.Ready, value: '62500000' },
      macdHistogramPriceMicros: { status: TechnicalReadiness.Ready, value: '-125000' },
      realizedVolatility60ReturnsPpm: { status: TechnicalReadiness.Warming, value: null },
    },
  }
  const observed = Date.parse(query.observedAt)
  const feature = Result.getOrThrow(
    decodeTechnicalMarketFeature({
      material,
      featureId: canonicalHashV1(material),
      producerRevision: 'jev-signal-fixture',
      computedAtMs: observed,
    }),
  )
  const topic = 'torghut.technical-features.v1'
  const projection = incorporateMarketRecord(
    { ...cut.projection, technicalTopic: topic },
    {
      topic,
      partition: 0,
      offset: '0',
      value: JSON.stringify(feature),
    },
    {
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: protocol.universe,
      topics: { ...protocol.sourceTopics, features: rolling.topic, technicalFeatures: topic },
    },
    observed,
  )
  return Result.getOrThrow(
    constructStreamingSnapshot(
      {
        projection,
        positions: [...cut.positions, { topic, partition: 0, offset: '1' }].sort((a, b) =>
          a.topic.localeCompare(b.topic),
        ),
        bootstrap: {
          ...cut.bootstrap,
          partitions: [
            ...cut.bootstrap.partitions,
            { topic, partition: 0, logStartOffset: '0', startOffset: '0', endOffset: '1' },
          ].sort((a, b) => a.topic.localeCompare(b.topic)),
        },
      },
      query,
    ),
  )
}

describe('Jev trading signal input', () => {
  test('reproduces the recorded simulated source before constructing the same signal input', () => {
    const fixture = simulationFixture()
    const snapshot = Result.getOrThrow(constructSimulatedSnapshot(fixture.cursor, fixture.source, fixture.query))
    const state = JSON.parse(Result.getOrThrow(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY')).body).state
    expect(state.session.observedAt).toBe(snapshot.manifest.observedAt)
    expect(state.candidate.bars1m).toHaveLength(30)
    expect(state.candidate.quote.ask).toBe(snapshot.latestQuotes['AAPL']?.askPrice)
    const altered = {
      ...snapshot,
      bars: snapshot.bars.map((bar, index) => (index === 0 ? { ...bar, close: bar.close + 1 } : bar)),
    }
    expect(Result.isFailure(makeJevTradingSignalRequest(altered, 'AAPL', 'SPY'))).toBe(true)
  })
  test('sends snapshot prices, volume, liquidity and computed relative signals without old strategy decisions', () => {
    const { snapshot } = streamingFixture({ AAPL: 0.02, SPY: 0.005 })
    const request = Result.getOrThrow(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))
    const state = JSON.parse(request.body).state
    expect(state.candidate.bars1m).toHaveLength(30)
    expect(state.benchmark.bars1m).toHaveLength(30)
    expect(state.candidate.quote.ask).toBe(snapshot.latestQuotes['AAPL']?.askPrice)
    expect(state.candidate.quote.bidSize).toBe(snapshot.latestQuotes['AAPL']?.bidSize)
    expect(state.candidate.bars1m[0].volume).toBe(snapshot.bars.find((bar) => bar.symbol === 'AAPL')?.volume)
    expect(state.relativeSignals.lookbackReturnBps).toBe(200)
    expect(state.relativeSignals.benchmarkReturnBps).toBe(50)
    expect(state.relativeSignals.excessReturnBps).toBe(150)
    expect(state.candidate.technicalAvailability).toBe('UNAVAILABLE')
    expect(state.candidate.technicalIndicators).toBeNull()
    expect(state.candidate.eligible).toBeUndefined()
    expect(state.candidate.rank).toBeUndefined()
    expect(state.news).toBeUndefined()
    expect(request.request.questions['setup_quality']?.type).toBe('score')
  })

  test('retains contradictory signals for Jev instead of filtering through the old momentum policy', () => {
    const { snapshot } = streamingFixture({ AAPL: -0.02, SPY: 0.005 })
    const state = JSON.parse(Result.getOrThrow(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY')).body).state
    expect(state.relativeSignals.lookbackReturnBps).toBe(-200)
    expect(state.relativeSignals.excessReturnBps).toBe(-250)
  })

  test('transmits technical values in explicit units and preserves individual readiness', () => {
    const request = Result.getOrThrow(makeJevTradingSignalRequest(snapshotWithTechnical(), 'AAPL', 'SPY'))
    const state = JSON.parse(request.body).state
    expect(state.candidate.technicalAvailability).toBe('RECORDED')
    expect(state.candidate.technicalIndicators.ema12PriceUsd).toEqual({ status: 'READY', value: 123.45 })
    expect(state.candidate.technicalIndicators.rsi14).toEqual({ status: 'READY', value: 62.5 })
    expect(state.candidate.technicalIndicators.macdHistogramPriceUsd).toEqual({ status: 'READY', value: -0.125 })
    expect(state.candidate.technicalIndicators.realizedVolatility60ReturnsRatio).toEqual({
      status: 'WARMING',
      value: null,
    })
    expect(state.benchmark.technicalAvailability).toBe('UNAVAILABLE')
    expect(state.session.completedBarWindowAgeMs).toBe(2000)
  })

  test('fails for unavailable subjects, stale quotes and identical candidate/benchmark roles', () => {
    const { snapshot } = streamingFixture()
    expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'MSFT', 'SPY'))).toBe(true)
    expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'AAPL'))).toBe(true)
    const stale = { ...snapshot, manifest: { ...snapshot.manifest, observedAt: '2026-09-04T14:31:02.000Z' } }
    expect(Result.isFailure(makeJevTradingSignalRequest(stale, 'AAPL', 'SPY'))).toBe(true)
  })

  test('rejects technical evidence from a different window, after observation, or with substituted source content', () => {
    const snapshot = snapshotWithTechnical()
    const technical = snapshot.manifest.streaming.technical
    const receipt = technical?.features[0]
    if (technical === undefined || receipt === undefined) throw new Error('Missing verified technical fixture')
    for (const changed of [
      { ...receipt, availableAtMs: Date.parse(snapshot.manifest.observedAt) + 1 },
      {
        ...receipt,
        value: {
          ...receipt.value,
          material: { ...receipt.value.material, windowEndMs: receipt.value.material.windowEndMs + 60_000 },
        },
      },
      {
        ...receipt,
        value: {
          ...receipt.value,
          material: {
            ...receipt.value.material,
            values: {
              ...receipt.value.material.values,
              ema12PriceMicros: { status: TechnicalReadiness.Ready, value: '999000000' },
            },
          },
        },
      },
    ]) {
      const changedValue = {
        ...changed,
        value: { ...changed.value, featureId: canonicalHashV1(changed.value.material) },
      }
      const input = {
        ...snapshot,
        manifest: {
          ...snapshot.manifest,
          streaming: { ...snapshot.manifest.streaming, technical: { ...technical, features: [changedValue] } },
        },
      }
      expect(Result.isFailure(makeJevTradingSignalRequest(input, 'AAPL', 'SPY'))).toBe(true)
    }
  })

  test('supports structured questions and validates all score levels and probabilities', () => {
    const prepared = Result.getOrThrow(
      prepareJevRequest({
        model: jevModel,
        state: { spreadBps: 2 },
        questions: {
          setup: {
            type: 'score',
            instructions: { question: 'How coherent is this setup?', fields: ['spreadBps'] },
            criteria: ['Weak', 'Mixed', 'Strong'],
          },
        },
      }),
    )
    const answer = {
      type: 'score',
      score: 1.3,
      confidence: 0.6,
      probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 },
      legend: { '0': 'Weak', '1': 'Mixed', '2': 'Strong' },
    }
    const response = (setup: unknown) => ({
      model: jevModel,
      answers: { setup },
      usage: { input_tokens: 100, output_tokens: 10 },
    })
    expect(Result.isSuccess(decodeJevResponse(prepared.request, response(answer)))).toBe(true)
    expect(Result.isFailure(prepareJevRequest({ ...prepared.request, state: 123 }))).toBe(true)
    for (const changed of [
      { ...answer, score: 3 },
      { ...answer, score: Number.NaN },
      { ...answer, legend: { ...answer.legend, '2': 'Changed' } },
      { ...answer, probabilities: { '0': 0.1, '1': 0.5, '3': 0.4 } },
      { ...answer, probabilities: { '0': 0.1, '1': 0.5, '2': 0.3 } },
    ])
      expect(Result.isFailure(decodeJevResponse(prepared.request, response(changed)))).toBe(true)
  })
})
