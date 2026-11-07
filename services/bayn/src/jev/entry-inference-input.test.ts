import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { EntryAblationSelection, prepareEntryInferenceInput } from './entry-inference-input'
import { defaultJevProtocolDocument, RetainedJevProtocolV37Schema, decodeJevProtocol } from './protocol'
import { WebullSession } from '../market-data/webull-contract'
import { webullEntryContextPolicy } from './webull-entry-context'

const bars = [
  { minuteBeforeWindowEnd: 2, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
  { minuteBeforeWindowEnd: 1, open: 100.5, high: 102, low: 100, close: 101, volume: 20 },
]
const input = {
  schemaVersion: 'bayn.entry-inference-input.v8',
  numericalState: {
    schemaVersion: defaultJevProtocolDocument.inputDefinition,
    webullContext: null,
    entryEconomics: { maximumEntryQuoteDriftBps: 0, maximumEntryLimitSlippageBps: 0 },
    task: { decisionPurpose: 'ENTRY' },
    candidate: { symbol: 'AAPL', bars1m: bars },
    session: { completedBarWindowEndsAt: '2026-10-25T07:00:00.000Z', observedAt: '2026-10-25T07:00:02.000Z' },
    benchmark: { symbol: 'SPY' },
  },
  chartSource: { symbol: 'AAPL', windowEndAt: '2026-10-25T07:00:00.000Z', bars },
  protocol: defaultJevProtocolDocument,
  funding: { bidMicros: '100000000', askMicros: '100010000', capitalMicros: '100000000000', cryptoFeeTier: null },
}

describe('sequential entry inference input', () => {
  test('retained v37 protocol bytes keep their original identity while current admission requires v39', () => {
    const retained = {
      ...defaultJevProtocolDocument,
      schemaVersion: 'bayn.jev.protocol.v37',
      inputDefinition: 'bayn.jev-entry-state.v23',
      entryQuestionPolicyHash: '0dd4b9c1a0b98df2878ad7fbbe3a1bac11571a50138cb1f0c883f89e3fedf9c5',
    }
    const decoded = Result.getOrThrow(Schema.decodeUnknownResult(RetainedJevProtocolV37Schema)(retained))
    expect(Result.getOrThrow(canonicalHashV1Result(decoded))).toBe(
      '4b6e3e1012a6439823c36fd3d7d982a87b263f13fccf079ff19e7f5d359953d6',
    )
    expect(Result.isFailure(decodeJevProtocol(retained))).toBe(true)
    expect(Result.isFailure(prepareEntryInferenceInput({ ...input, protocol: retained }))).toBe(true)
  })

  test('rejects wrong-symbol, future, late, unfinished and malformed Webull context instead of substituting IEX data', () => {
    const context = {
      ...webullEntryContextPolicy,
      symbol: 'AAPL',
      windowStartAt: '2026-10-25T06:59:00.000Z',
      windowEndAt: '2026-10-25T07:00:00.000Z',
      session: WebullSession.Regular,
      open: '100',
      high: '102',
      low: '99',
      close: '101.000000000000000001',
      volume: '12345',
      receivedAt: '2026-10-25T07:00:01.000000000Z',
      availableAt: '2026-10-25T07:00:01.500Z',
      availabilityLagMs: 1500,
    }
    const withContext = (webullContext: unknown) => ({
      ...input,
      numericalState: { ...input.numericalState, webullContext },
    })
    expect(Result.isSuccess(prepareEntryInferenceInput(withContext(context)))).toBe(true)
    for (const changed of [
      undefined,
      { ...context, symbol: 'AMD' },
      { ...context, availableAt: '2026-10-25T07:00:03.000Z', availabilityLagMs: 3000 },
      { ...context, availableAt: '2026-10-25T07:00:10.001Z', availabilityLagMs: 10001 },
      { ...context, windowStartAt: context.windowEndAt },
      { ...context, high: '100' },
      { ...context, close: 'NaN' },
      { ...context, feed: 'sip' },
      { ...context, unboundSource: 'other-feed' },
    ])
      expect(Result.isFailure(prepareEntryInferenceInput(withContext(changed)))).toBe(true)
  })

  test('binds ablation selection to a distinct request and rejects absent or substituted policies', () => {
    const ablation = {
      ...input,
      schemaVersion: 'bayn.entry-ablation-input.v1',
      selectionPolicy: EntryAblationSelection.LowestModeledLoss,
    }
    const prepared = Result.getOrThrow(prepareEntryInferenceInput(ablation))
    expect(prepared.requestHash).not.toBe(Result.getOrThrow(prepareEntryInferenceInput(input)).requestHash)
    for (const changed of [
      { ...input, schemaVersion: ablation.schemaVersion },
      { ...ablation, selectionPolicy: 'BEST_OBSERVED_PROFIT' },
      { ...ablation, schemaVersion: input.schemaVersion },
    ])
      expect(Result.isFailure(prepareEntryInferenceInput(changed))).toBe(true)
  })

  test('rejects all retired chart-question input contracts for execution', () => {
    for (const schemaVersion of [
      'bayn.entry-inference-input.v1',
      'bayn.entry-inference-input.v2',
      'bayn.entry-inference-input.v3',
      'bayn.entry-inference-input.v4',
      'bayn.entry-inference-input.v5',
      'bayn.entry-inference-input.v6',
      'bayn.entry-inference-input.v7',
    ])
      expect(Result.isFailure(prepareEntryInferenceInput({ ...input, schemaVersion }))).toBe(true)
  })

  test('seals source facts before either provider body is evaluated', () => {
    const prepared = Result.getOrThrow(prepareEntryInferenceInput(input))
    expect(prepared.requestHash).toBe(Result.getOrThrow(canonicalHashV1Result(prepared.input)))
    expect(JSON.parse(prepared.body)).toEqual(prepared.input)
    expect(prepared.input.chartSource.bars).toEqual(bars)
  })

  test('rejects mismatched numerical and image source bars', () => {
    expect(
      Result.isFailure(
        prepareEntryInferenceInput({
          ...input,
          numericalState: {
            ...input.numericalState,
            candidate: { symbol: 'AAPL', bars1m: bars.map((bar) => ({ ...bar, volume: bar.volume + 1 })) },
          },
        }),
      ),
    ).toBe(true)
  })

  test('rejects wrong symbols, windows, crossed quotes and unfinished candles', () => {
    for (const changed of [
      { ...input, chartSource: { ...input.chartSource, symbol: 'MSFT' } },
      { ...input, chartSource: { ...input.chartSource, windowEndAt: '2026-10-25T07:01:00.000Z' } },
      { ...input, funding: { ...input.funding, bidMicros: '101000000' } },
      {
        ...input,
        chartSource: { ...input.chartSource, bars: bars.map((bar) => ({ ...bar, minuteBeforeWindowEnd: 0 })) },
      },
    ])
      expect(Result.isFailure(prepareEntryInferenceInput(changed))).toBe(true)
  })

  test('rejects the retired model-request shape without a compatibility path', () => {
    expect(
      Result.isFailure(
        prepareEntryInferenceInput({
          model: 'jev-1.13.0',
          state: input.numericalState,
          questions: {
            action: { type: 'choice', instructions: 'Choose a plan', criteria: { wait: 'Wait', plan_0: 'Enter' } },
          },
        }),
      ),
    ).toBe(true)
  })

  test('rejects the retired whole-unit volume rendering contract for execution', () => {
    expect(
      Result.isFailure(prepareEntryInferenceInput({ ...input, schemaVersion: 'bayn.entry-inference-input.v1' })),
    ).toBe(true)
  })
})

test('equity funding cannot import a crypto fee tier', () => {
  expect(
    Result.isFailure(prepareEntryInferenceInput({ ...input, funding: { ...input.funding, cryptoFeeTier: 4 } })),
  ).toBe(true)
})
