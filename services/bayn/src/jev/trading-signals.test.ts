import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import technicalFixture from '../market-data/features/fixtures/technical-indicators-v1.json'
import { TechnicalMarketFeatureSchema, TechnicalReadiness } from '../market-data/features/technical-contract'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { makeJevTradingSignalRequest } from './trading-signals'
import { decodeJevResponse, jevModel, prepareJevRequest } from './contract'

describe('Jev trading signal input', () => {
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
    const { snapshot } = streamingFixture()
    const feature = Schema.decodeUnknownSync(TechnicalMarketFeatureSchema)(technicalFixture)
    const technical = {
      topic: 'torghut.technical-features.v1',
      unavailableSymbols: ['SPY'],
      features: [
        {
          topic: 'torghut.technical-features.v1',
          partition: 0,
          offset: '1',
          availableAtMs: Date.parse(snapshot.manifest.observedAt),
          sequence: 500,
          value: {
            ...feature,
            material: {
              ...feature.material,
              values: {
                ...feature.material.values,
                ema12PriceMicros: { status: TechnicalReadiness.Ready, value: '123450000' },
                rsi14Micros: { status: TechnicalReadiness.Ready, value: '62500000' },
                macdHistogramPriceMicros: { status: TechnicalReadiness.Ready, value: '-125000' },
                realizedVolatility60ReturnsPpm: { status: TechnicalReadiness.Ready, value: '1500' },
                macdSignalPriceMicros: { status: TechnicalReadiness.Warming, value: null },
              },
            },
          },
        },
      ],
    }
    const request = Result.getOrThrow(
      makeJevTradingSignalRequest(
        {
          ...snapshot,
          manifest: { ...snapshot.manifest, streaming: { ...snapshot.manifest.streaming, technical } },
        },
        'AAPL',
        'SPY',
      ),
    )
    const state = JSON.parse(request.body).state
    expect(state.candidate.technicalAvailability).toBe('RECORDED')
    expect(state.candidate.technicalIndicators.ema12PriceUsd).toEqual({ status: 'READY', value: 123.45 })
    expect(state.candidate.technicalIndicators.rsi14).toEqual({ status: 'READY', value: 62.5 })
    expect(state.candidate.technicalIndicators.macdHistogramPriceUsd).toEqual({ status: 'READY', value: -0.125 })
    expect(state.candidate.technicalIndicators.realizedVolatility60ReturnsRatio).toEqual({
      status: 'READY',
      value: 0.0015,
    })
    expect(state.candidate.technicalIndicators.macdSignalPriceUsd).toEqual({ status: 'WARMING', value: null })
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
