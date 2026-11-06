import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Redacted, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { canonicalHashV1Result } from '../hash'
import { makeNativeChartEvidence } from './chart-evidence'
import { JevClient, JevClientLive } from './client'
import { decodeJevResponse, prepareJevRequest, type JevRequest, type JevResponse } from './contract'
import { defaultJevProtocolDocument } from './protocol'
import {
  decodeSelectedBaseStartStageResponse,
  makeInitialChartStageRequest,
  makeFinancialChartStageReplay,
  makeSelectedBaseStartStageRequest,
  stagedChartAssessments,
} from './staged-chart-questions'

const source = (count: number, extreme = false) => ({
  symbol: 'ETH/USD',
  windowEndAt: '2026-10-25T07:00:00.000Z',
  bars: Array.from({ length: count }, (_, index) => ({
    minuteBeforeWindowEnd: count - index,
    open: extreme ? 1e100 : 99,
    high: extreme ? Number.MAX_VALUE : index === count - 1 ? 130 : 100,
    low: extreme ? Number.MIN_VALUE : 90,
    close: extreme ? 1e-100 : 99,
    volume: extreme ? Number.MAX_VALUE : 0.12345678901234568 + index,
  })),
})
const fundedSource = (chart: Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>) => ({
  chart,
  protocol: defaultJevProtocolDocument,
  funding: { bidMicros: '101000000', askMicros: '101010000', capitalMicros: '10000000000', cryptoFeeTier: null },
})
const responseFor = (request: JevRequest, end?: string): JevResponse => ({
  model: request.model,
  answers: Object.fromEntries(
    Object.entries(request.questions).map(([name, question]) => {
      if (question.type === 'noul') return [name, { type: 'noul', noul: 0.12345678901234568 }]
      if (question.type !== 'choice') throw new Error('Unexpected chart question')
      const choices = Object.keys(question.criteria)
      const choice = name === 'base_last_bar' ? (end ?? choices.at(-2)) : choices[0]
      if (choice === undefined) throw new Error('Expected a source choice')
      return [
        name,
        {
          type: 'choice',
          choice,
          confidence: 0.12345678901234568,
          probabilities: Object.fromEntries(choices.map((value) => [value, 1 / choices.length])),
        },
      ]
    }),
  ),
  usage: { input_tokens: 100, output_tokens: 10 },
})
const receiptFor = (prepared: { readonly requestHash: string }, response: unknown) => ({
  requestHash: prepared.requestHash,
  responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
  response,
})
const choose = (response: JevResponse, name: string, value: string): JevResponse => {
  const answer = response.answers[name]
  if (answer?.type !== 'choice') throw new Error('Expected a choice answer')
  return {
    ...response,
    answers: {
      ...response.answers,
      [name]: {
        ...answer,
        choice: value,
        probabilities: Object.fromEntries(Object.keys(answer.probabilities).map((key) => [key, key === value ? 1 : 0])),
      },
    },
  }
}

describe('Jev-only staged chart transport', () => {
  for (const count of [1, 2, 6, 30, 120])
    for (const extreme of [false, true]) {
      test(`${count} bars, extreme=${extreme}: preserves complete source and finite probability precision`, () => {
        const chart = Result.getOrThrow(makeNativeChartEvidence(source(count, extreme)))
        const input = fundedSource(chart)
        const first = Result.getOrThrow(makeInitialChartStageRequest(input))
        const raw = responseFor(first.request)
        expect(Result.isSuccess(decodeJevResponse(first.request, raw))).toBe(true)
        expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(128000)
        expect(first.request.model).toBe('jev-1.13.0')
        expect(first.request.assets?.[`bayn_chart_image_${chart.pngHash}`]?.data_base64).toBe(chart.image.split(',')[1])
        expect(first.request.state).toMatchObject({
          source: { symbol: chart.symbol, bars: chart.bars, barsHash: chart.barsHash, pngHash: chart.pngHash },
        })
        const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(input, receiptFor(first, raw)))
        let base = null
        if (next.status === 'PREPARED') {
          expect(Object.keys(next.request.questions)).toHaveLength(1)
          expect(Buffer.byteLength(next.body)).toBeLessThanOrEqual(128000)
          base = receiptFor(next, responseFor(next.request))
        }
        const assessment = Result.getOrThrow(stagedChartAssessments(input, receiptFor(first, raw), base))
        expect(assessment.base.presence).toEqual({ status: 'ASSESSED', probability: 0.12345678901234568 })
        const replay = makeFinancialChartStageReplay()
        expect(Result.getOrThrow(replay.makeInitialChartStageRequest(input))).toEqual(first)
        expect(Result.getOrThrow(replay.makeSelectedBaseStartStageRequest(input, receiptFor(first, raw)))).toEqual(next)
        expect(Result.getOrThrow(replay.stagedChartAssessments(input, receiptFor(first, raw), base))).toEqual(
          assessment,
        )
      })
    }

  test('financial replay binds complete source and response material on every reuse', () => {
    const input = fundedSource(Result.getOrThrow(makeNativeChartEvidence(source(6))))
    const first = Result.getOrThrow(makeInitialChartStageRequest(input))
    const response = responseFor(first.request)
    const receipt = receiptFor(first, response)
    const replay = makeFinancialChartStageReplay()
    const next = Result.getOrThrow(replay.makeSelectedBaseStartStageRequest(input, receipt))
    expect(next).toEqual(Result.getOrThrow(makeSelectedBaseStartStageRequest(input, receipt)))
    for (const altered of [
      { ...input, funding: { ...input.funding, capitalMicros: '9000000000' } },
      { ...input, protocol: { ...input.protocol, inferenceValidityMs: input.protocol.inferenceValidityMs + 1 } },
      { ...input, chart: { ...input.chart, image: input.chart.image + 'changed' } },
      fundedSource(Result.getOrThrow(makeNativeChartEvidence(source(7)))),
    ]) {
      expect(replay.makeInitialChartStageRequest(altered)).toEqual(makeInitialChartStageRequest(altered))
      expect(replay.makeSelectedBaseStartStageRequest(altered, receipt)).toEqual(
        makeSelectedBaseStartStageRequest(altered, receipt),
      )
    }
    for (const altered of [
      { ...receipt, requestHash: 'f'.repeat(64) },
      { ...receipt, responseHash: 'f'.repeat(64) },
      { ...receipt, response: { ...response, usage: { ...response.usage, input_tokens: 101 } } },
      { ...receipt, extra: true },
    ]) {
      expect(Result.isFailure(replay.makeSelectedBaseStartStageRequest(input, altered))).toBe(true)
      expect(Result.isFailure(replay.stagedChartAssessments(input, altered, null))).toBe(true)
    }
    const changedEnd = input.chart.bars[1]
    if (changedEnd === undefined) throw new Error('Missing eligible end')
    const changedReceipt = receiptFor(first, responseFor(first.request, changedEnd.id))
    expect(replay.makeSelectedBaseStartStageRequest(input, changedReceipt)).toEqual(
      makeSelectedBaseStartStageRequest(input, changedReceipt),
    )
    if (next.status !== 'PREPARED') throw new Error('Expected selected base')
    const base = receiptFor(next, responseFor(next.request))
    expect(replay.stagedChartAssessments(input, receipt, base)).toEqual(stagedChartAssessments(input, receipt, base))
    expect(
      Result.isFailure(replay.stagedChartAssessments(input, receipt, { ...base, responseHash: 'f'.repeat(64) })),
    ).toBe(true)
  })

  test('offers every eligible earlier start and no-match for the selected end', () => {
    const input = fundedSource(Result.getOrThrow(makeNativeChartEvidence(source(120))))
    const first = Result.getOrThrow(makeInitialChartStageRequest(input))
    const end = input.chart.bars[100]
    if (end === undefined) throw new Error('Missing end')
    const next = Result.getOrThrow(
      makeSelectedBaseStartStageRequest(input, receiptFor(first, responseFor(first.request, end.id))),
    )
    if (next.status !== 'PREPARED') throw new Error('Expected base start')
    const question = Object.values(next.request.questions)[0]
    if (question?.type !== 'choice') throw new Error('Expected a choice')
    expect(Object.keys(question.criteria)).toEqual([...input.chart.bars.slice(0, 100).map((bar) => bar.id), 'no_base'])
  })

  test('retains an authenticated no-base outcome without fabricating a start', () => {
    const input = fundedSource(Result.getOrThrow(makeNativeChartEvidence(source(6))))
    const first = Result.getOrThrow(makeInitialChartStageRequest(input))
    const receipt = receiptFor(first, responseFor(first.request, 'no_base'))
    expect(Result.getOrThrow(makeSelectedBaseStartStageRequest(input, receipt))).toMatchObject({
      status: 'NOT_REQUESTED',
      reason: 'NO_BASE',
    })
    const assessment = Result.getOrThrow(stagedChartAssessments(input, receipt, null))
    expect(assessment.base.first).toEqual({ status: 'NOT_IDENTIFIED' })
    expect(assessment.support.presence.status).toBe('ASSESSED')
    expect(Result.isFailure(stagedChartAssessments(input, receipt, receipt))).toBe(true)
  })

  test('rejects missing, foreign, mistyped and nonmaximum answers before admitting the next stage', () => {
    const input = fundedSource(Result.getOrThrow(makeNativeChartEvidence(source(6))))
    const first = Result.getOrThrow(makeInitialChartStageRequest(input))
    const raw = responseFor(first.request)
    const { base_last_bar: removed, ...remaining } = raw.answers
    if (removed?.type !== 'choice') throw new Error('Expected base choice')
    const invalid = [
      { ...raw, answers: remaining },
      { ...raw, answers: { ...raw.answers, foreign: { type: 'noul', noul: 1 } } },
      { ...raw, answers: { ...raw.answers, base_last_bar: { type: 'noul', noul: 1 } } },
      { ...raw, answers: { ...raw.answers, base_last_bar: { ...removed, choice: 'not_a_source_bar' } } },
      { ...raw, answers: { ...raw.answers, base_last_bar: { ...removed, type: 'refusal' } } },
      { ...raw, model: 'gpt-6-luna' },
    ]
    for (const changed of invalid)
      expect(Result.isFailure(makeSelectedBaseStartStageRequest(input, receiptFor(first, changed)))).toBe(true)
    const other = Object.keys(removed.probabilities).find((value) => value !== removed.choice)
    if (other === undefined) throw new Error('Expected competing choice')
    const nonmaximum = {
      ...raw,
      answers: {
        ...raw.answers,
        base_last_bar: {
          ...removed,
          probabilities: Object.fromEntries(
            Object.keys(removed.probabilities).map((value) => [value, value === other ? 1 : 0]),
          ),
        },
      },
    }
    expect(Result.isFailure(makeSelectedBaseStartStageRequest(input, receiptFor(first, nonmaximum)))).toBe(true)
    const reordered = { ...raw, answers: Object.fromEntries(Object.entries(raw.answers).toReversed()) }
    expect(Result.isSuccess(makeSelectedBaseStartStageRequest(input, receiptFor(first, reordered)))).toBe(true)
  })

  test('rejects source, predecessor, request-hash and response-hash substitutions', () => {
    const input = fundedSource(Result.getOrThrow(makeNativeChartEvidence(source(6))))
    const first = Result.getOrThrow(makeInitialChartStageRequest(input))
    const initial = receiptFor(first, responseFor(first.request))
    const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(input, initial))
    if (next.status !== 'PREPARED') throw new Error('Expected base start')
    const base = receiptFor(next, responseFor(next.request))
    for (const changed of [
      { ...base, requestHash: 'a'.repeat(64) },
      { ...base, responseHash: 'b'.repeat(64) },
    ])
      expect(Result.isFailure(decodeSelectedBaseStartStageResponse(input, initial, changed))).toBe(true)
    const changedSource = fundedSource(
      Result.getOrThrow(makeNativeChartEvidence({ ...source(6), windowEndAt: '2026-10-25T07:01:00.000Z' })),
    )
    expect(Result.isFailure(stagedChartAssessments(changedSource, initial, base))).toBe(true)
    const changedInitial = receiptFor(
      first,
      choose(responseFor(first.request), 'base_last_bar', input.chart.bars[1]?.id ?? 'missing'),
    )
    expect(Result.isFailure(decodeSelectedBaseStartStageResponse(input, changedInitial, base))).toBe(true)
  })

  test('both 120-bar stages use only the pinned Jev endpoint and image opt-in', async () => {
    const input = fundedSource(Result.getOrThrow(makeNativeChartEvidence(source(120))))
    const first = Result.getOrThrow(makeInitialChartStageRequest(input))
    const sent: string[] = []
    const http = HttpClient.make((request, url) => {
      sent.push(url.toString())
      expect(request.headers['typesafe-danger-zone-images']).toBe('true')
      const body = request.body
      if (body._tag !== 'Uint8Array') throw new Error('Expected sealed JSON')
      const parsed: unknown = JSON.parse(Buffer.from(body.body).toString('utf8'))
      const prepared = Result.getOrThrow(prepareJevRequest(parsed))
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(responseFor(prepared.request)))),
      )
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* JevClient
        const initial = yield* client.evaluate(first.request, 10000)
        const next = yield* Effect.fromResult(
          makeSelectedBaseStartStageRequest(input, receiptFor(first, initial.response)),
        )
        if (next.status !== 'PREPARED') throw new Error('Expected base start')
        return yield* client.evaluate(next.request, 10000)
      }).pipe(
        Effect.provide(JevClientLive(Redacted.make('fixture-key'), 10000)),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      ),
    )
    expect(result.response.model).toBe('jev-1.13.0')
    expect(sent).toEqual(['https://api.typesafe.ai/v1/systemone', 'https://api.typesafe.ai/v1/systemone'])
  })
})
