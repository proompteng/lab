import { describe, expect, test } from 'bun:test'
import { Effect, Layer, Redacted, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { canonicalHashV1Result } from '../hash'
import { makeNativeChartEvidence } from './chart-evidence'
import { makeChartDecisionsRequest } from './chart-questions'
import { defaultJevProtocolDocument } from './protocol'
import { jevEntryEconomics } from './entry-economics'
import { makeEntrySourceCandidates } from './entry-proposals'
import {
  DecisionsClient,
  DecisionsClientLive,
  decodeDecisionsResponse,
  type DecisionsRequest,
  type DecisionsResponse,
} from './decisions'
import {
  decodeSelectedBaseStartStageResponse,
  makeInitialChartStageRequest,
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
const candidatesFor = (chart: Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>) => {
  const { protocol, funding } = fundedSource(chart)
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      protocol,
      symbol: chart.symbol,
      ...funding,
      bidMicros: BigInt(funding.bidMicros),
      askMicros: BigInt(funding.askMicros),
    }),
  )
  if (economics === null) throw new Error('Expected funded fixture economics')
  return Result.getOrThrow(
    makeEntrySourceCandidates({ chart, protocol, economics, bidMicros: BigInt(funding.bidMicros) }),
  )
}
const responseFor = (request: DecisionsRequest, end?: string): DecisionsResponse => ({
  model: request.model,
  answers: request.questions.map((question) => {
    if (question.type === 'predicate')
      return { type: 'predicate', name: question.name, probability: 0.12345678901234568 }
    const choice =
      question.name === 'base_last_bar' ? (end ?? question.choices.at(-2)?.value) : question.choices[0]?.value
    if (choice === undefined) throw new Error('Expected choices')
    return {
      type: 'choice',
      name: question.name,
      choice,
      confidence: 0.12345678901234568,
      probabilities: question.choices.map((candidate) => ({
        value: candidate.value,
        probability: 1 / question.choices.length,
      })),
    }
  }),
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 10,
    total_tokens: 110,
  },
})
const choicesCount = (request: DecisionsRequest) =>
  request.questions.reduce((count, question) => count + (question.type === 'choice' ? question.choices.length : 0), 0)
const receiptFor = (prepared: { readonly requestHash: string }, response: unknown) => ({
  requestHash: prepared.requestHash,
  responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
  response,
})

describe('funded staged chart transport', () => {
  for (const count of [1, 2, 6, 30, 120])
    for (const extreme of [false, true]) {
      test(`${count} bars, extreme=${extreme}: complete source and full precision responses fit unchanged budgets`, () => {
        const chart = Result.getOrThrow(makeNativeChartEvidence(source(count, extreme)))
        const first = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(chart)))
        const raw = responseFor(first.request)
        expect(Result.isSuccess(decodeDecisionsResponse(first.request, raw))).toBe(true)
        expect(Buffer.byteLength(first.body)).toBeLessThan(1_048_576)
        expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(262_144)
        expect(choicesCount(first.request)).toBeLessThanOrEqual(361)
        expect(first.request.input[0].content[1].image_url).toBe(chart.image)
        expect(first.request.input[0].content[2].data).toMatchObject({
          symbol: chart.symbol,
          windowEndAt: chart.windowEndAt,
          barsHash: chart.barsHash,
          pngHash: chart.pngHash,
          bars: chart.bars,
        })
        const receipt = receiptFor(first, raw)
        const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(fundedSource(chart), receipt))
        if (count < 3 || extreme) {
          expect(next.status).toBe('NOT_REQUESTED')
          if (next.status === 'NOT_REQUESTED')
            expect(next.reason).toBe(count < 3 ? 'INSUFFICIENT_BARS' : 'NO_ELIGIBLE_BASE')
        } else {
          if (next.status !== 'PREPARED') throw new Error('Expected selected base start')
          expect(next.request.questions).toHaveLength(1)
          expect(choicesCount(next.request)).toBe(count - 1)
          expect(Buffer.byteLength(next.body)).toBeLessThan(1_048_576)
          const second = responseFor(next.request)
          expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThan(262_144)
          expect(
            Result.isSuccess(
              decodeSelectedBaseStartStageResponse(fundedSource(chart), receipt, receiptFor(next, second)),
            ),
          ).toBe(true)
          expect(next.predecessor).toEqual({
            requestHash: first.requestHash,
            responseHash: Result.getOrThrow(canonicalHashV1Result(raw)),
          })
        }
        // Compare funded source identity against the unpartitioned builder when it fits.
        const active = makeChartDecisionsRequest(fundedSource(chart))
        if (Result.isSuccess(active)) {
          expect(first.request.input).toEqual(active.success.request.input)
          expect(first.request.questions).toEqual(
            active.success.request.questions.filter((question) => !question.name.startsWith('base_first_bar_ending_')),
          )
        }
      })
    }

  describe('each funded 120-bar end retains exactly funded earlier full source IDs and no_base', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source(120)))
    const first = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(chart)))
    const candidates = candidatesFor(chart)
    const ends = chart.bars.filter((bar) => candidates.baseWindows.some((window) => window.lastBarId === bar.id))
    expect(ends).toHaveLength(118)
    for (const end of ends)
      test(end.chartLabel, () => {
        const next = Result.getOrThrow(
          makeSelectedBaseStartStageRequest(fundedSource(chart), receiptFor(first, responseFor(first.request, end.id))),
        )
        if (next.status !== 'PREPARED') throw new Error('Expected selected base start')
        const question = next.request.questions[0]
        if (question?.type !== 'choice') throw new Error('Expected choice')
        expect(question.name).toBe(`base_first_bar_ending_${end.chartLabel}`)
        expect(question.instructions).toContain(end.timestamp)
        expect(question.choices.map((choice) => choice.value)).toEqual([
          ...chart.bars
            .filter((bar) =>
              candidates.baseWindows.some((window) => window.lastBarId === end.id && window.firstBarId === bar.id),
            )
            .map((bar) => bar.id),
          'no_base',
        ])
      })
  })

  test('funded support without any eligible base has an authenticated distinct skip', () => {
    const raw = source(6)
    const chart = Result.getOrThrow(
      makeNativeChartEvidence({ ...raw, bars: raw.bars.map((bar) => ({ ...bar, high: 130 })) }),
    )
    const context = fundedSource(chart)
    const first = Result.getOrThrow(makeInitialChartStageRequest(context))
    expect(first.sourceFeasible).toBe(true)
    expect(candidatesFor(chart).baseWindows).toHaveLength(0)
    expect(first.request.questions.some((question) => question.name === 'support_anchor')).toBe(true)
    expect(first.request.questions.some((question) => question.name === 'resistance_anchor')).toBe(true)
    expect(first.request.questions.some((question) => question.name === 'base_last_bar')).toBe(false)
    const receipt = receiptFor(first, responseFor(first.request))
    const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(context, receipt))
    expect(next).toEqual({
      status: 'NOT_REQUESTED',
      reason: 'NO_ELIGIBLE_BASE',
      predecessor: { requestHash: receipt.requestHash, responseHash: receipt.responseHash },
    })
    expect(Result.isSuccess(stagedChartAssessments(context, receipt, null))).toBe(true)
    expect(Result.isFailure(stagedChartAssessments(context, receipt, receipt))).toBe(true)
    expect(
      Result.isFailure(
        makeSelectedBaseStartStageRequest(
          { ...context, funding: { ...context.funding, bidMicros: '102000000', askMicros: '102010000' } },
          receipt,
        ),
      ),
    ).toBe(true)
  })

  test('selected end excludes earlier starts whose window crosses an unfundable high', () => {
    const raw = source(6)
    const chart = Result.getOrThrow(
      makeNativeChartEvidence({
        ...raw,
        bars: raw.bars.map((bar, index) => (index === 2 ? { ...bar, high: 130 } : bar)),
      }),
    )
    const context = fundedSource(chart)
    const first = Result.getOrThrow(makeInitialChartStageRequest(context))
    const end = chart.bars[4]
    const start = chart.bars[3]
    if (end === undefined || start === undefined) throw new Error('Expected fixture bars')
    const initial = receiptFor(first, responseFor(first.request, end.id))
    const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(context, initial))
    if (next.status !== 'PREPARED') throw new Error('Expected selected stage')
    const question = next.request.questions[0]
    if (question?.type !== 'choice') throw new Error('Expected selected question')
    expect(question.choices.map((choice) => choice.value)).toEqual([start.id, 'no_base'])
    const valid = responseFor(next.request)
    const forged = {
      ...valid,
      answers: valid.answers.map((answer) =>
        answer.type === 'choice' ? { ...answer, choice: chart.bars[0]?.id } : answer,
      ),
    }
    expect(Result.isFailure(decodeSelectedBaseStartStageResponse(context, initial, receiptFor(next, forged)))).toBe(
      true,
    )
  })

  test('no_base and refusal remain explicit not-requested outcomes, not fabricated starts', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source(6)))
    const first = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(chart)))
    const noBase = responseFor(first.request, 'no_base')
    const refused = {
      ...noBase,
      answers: noBase.answers.map((answer) =>
        answer.name === 'base_last_bar' ? { type: 'refusal' as const, name: answer.name } : answer,
      ),
    }
    for (const [raw, reason] of [
      [noBase, 'NO_BASE'],
      [refused, 'END_REFUSED'],
    ] as const) {
      const receipt = receiptFor(first, raw)
      const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(fundedSource(chart), receipt))
      expect(next.status).toBe('NOT_REQUESTED')
      if (next.status === 'NOT_REQUESTED') expect(next.reason).toBe(reason)
      expect(Result.isSuccess(stagedChartAssessments(fundedSource(chart), receipt, null))).toBe(true)
      expect(Result.isFailure(stagedChartAssessments(fundedSource(chart), receipt, receipt))).toBe(true)
      expect(
        Result.isFailure(decodeSelectedBaseStartStageResponse(fundedSource(chart), receipt, receiptFor(first, noBase))),
      ).toBe(true)
    }
  })

  test('rejects incomplete, reordered, extra and invalid end responses before constructing the next stage', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source(6)))
    const first = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(chart)))
    const raw = responseFor(first.request)
    for (const answers of [
      raw.answers.slice(1),
      raw.answers.toReversed(),
      [...raw.answers, raw.answers[0]],
      raw.answers.map((answer) =>
        answer.type === 'choice' && answer.name === 'base_last_bar'
          ? { ...answer, choice: chart.bars.at(-1)?.id }
          : answer,
      ),
      raw.answers.map((answer) =>
        answer.type === 'choice' ? { ...answer, probabilities: answer.probabilities.slice(1) } : answer,
      ),
      raw.answers.map((answer) =>
        answer.type === 'choice'
          ? { ...answer, probabilities: answer.probabilities.map((entry) => ({ ...entry, probability: 1 })) }
          : answer,
      ),
    ]) {
      expect(
        Result.isFailure(
          makeSelectedBaseStartStageRequest(fundedSource(chart), receiptFor(first, { ...raw, answers })),
        ),
      ).toBe(true)
      expect(
        Result.isFailure(stagedChartAssessments(fundedSource(chart), receiptFor(first, { ...raw, answers }), null)),
      ).toBe(true)
    }
  })

  test('source and predecessor substitutions fail even when the response envelope is rehashed', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source(6)))
    const first = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(chart)))
    const raw = responseFor(first.request)
    const initialReceipt = receiptFor(first, raw)
    const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(fundedSource(chart), initialReceipt))
    if (next.status !== 'PREPARED') throw new Error('Expected selected base start')
    const start = responseFor(next.request)
    const startReceipt = receiptFor(next, start)
    expect(Result.isSuccess(stagedChartAssessments(fundedSource(chart), initialReceipt, startReceipt))).toBe(true)
    const changedSource = source(6)
    const changed = Result.getOrThrow(
      makeNativeChartEvidence({
        ...changedSource,
        bars: changedSource.bars.map((bar) => ({ ...bar, volume: bar.volume + 1 })),
      }),
    )
    const changedFirst = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(changed)))
    expect(changedFirst.requestHash).not.toBe(first.requestHash)
    expect(Result.isFailure(makeSelectedBaseStartStageRequest(fundedSource(changed), initialReceipt))).toBe(true)
    expect(Result.isFailure(stagedChartAssessments(fundedSource(changed), initialReceipt, startReceipt))).toBe(true)
    const changedInitialReceipt = receiptFor(changedFirst, raw)
    const changedNext = Result.getOrThrow(
      makeSelectedBaseStartStageRequest(fundedSource(changed), changedInitialReceipt),
    )
    if (changedNext.status !== 'PREPARED') throw new Error('Expected selected base start')
    expect(changedNext.requestHash).not.toBe(next.requestHash)
    expect(
      Result.isFailure(
        decodeSelectedBaseStartStageResponse(fundedSource(changed), changedInitialReceipt, startReceipt),
      ),
    ).toBe(true)
    const changedRaw = { ...raw, usage: { ...raw.usage, input_tokens: 101, total_tokens: 111 } }
    const changedPredecessor = receiptFor(first, changedRaw)
    expect(
      Result.isFailure(decodeSelectedBaseStartStageResponse(fundedSource(chart), changedPredecessor, startReceipt)),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeSelectedBaseStartStageRequest(fundedSource(chart), { ...initialReceipt, response: changedRaw }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeSelectedBaseStartStageResponse(fundedSource(chart), initialReceipt, {
          ...startReceipt,
          responseHash: '0'.repeat(64),
        }),
      ),
    ).toBe(true)
    const invalidStart = {
      ...start,
      answers: start.answers.map((answer) =>
        answer.type === 'choice' ? { ...answer, choice: next.selectedEnd } : answer,
      ),
    }
    expect(
      Result.isFailure(
        decodeSelectedBaseStartStageResponse(fundedSource(chart), initialReceipt, receiptFor(next, invalidStart)),
      ),
    ).toBe(true)
  })

  test('selected start retains tiny finite probabilities, no_base and independent refusal', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source(120)))
    const first = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(chart)))
    const initial = receiptFor(first, responseFor(first.request))
    const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(fundedSource(chart), initial))
    if (next.status !== 'PREPARED') throw new Error('Expected selected base start')
    const response = responseFor(next.request)
    for (const choice of [chart.bars[0]?.id, 'no_base']) {
      const raw = {
        ...response,
        answers: response.answers.map((answer) =>
          answer.type === 'choice'
            ? {
                ...answer,
                choice,
                probabilities: answer.probabilities.map((entry) => ({
                  ...entry,
                  probability: entry.value === choice ? 1 : Number.MIN_VALUE,
                })),
              }
            : answer,
        ),
      }
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(262_144)
      expect(
        Result.isSuccess(decodeSelectedBaseStartStageResponse(fundedSource(chart), initial, receiptFor(next, raw))),
      ).toBe(true)
    }
    const refused = {
      ...response,
      answers: response.answers.map((answer) => ({ type: 'refusal' as const, name: answer.name })),
    }
    expect(
      Result.getOrThrow(decodeSelectedBaseStartStageResponse(fundedSource(chart), initial, receiptFor(next, refused)))
        .response.answers,
    ).toEqual(refused.answers)
  })

  test('both serialized 120-bar responses pass the real bounded transport using an offline HTTP layer', async () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source(120)))
    const first = Result.getOrThrow(makeInitialChartStageRequest(fundedSource(chart)))
    const firstRaw = responseFor(first.request)
    const second = Result.getOrThrow(
      makeSelectedBaseStartStageRequest(fundedSource(chart), receiptFor(first, firstRaw)),
    )
    if (second.status !== 'PREPARED') throw new Error('Expected selected base start')
    for (const request of [first.request, second.request]) {
      const raw = responseFor(request)
      const http = HttpClient.make((httpRequest) =>
        Effect.succeed(HttpClientResponse.fromWeb(httpRequest, new Response(JSON.stringify(raw), { status: 200 }))),
      )
      const layer = DecisionsClientLive(Redacted.make('offline-test-key'), 1000).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* DecisionsClient
          return yield* client.evaluate(request, 1000)
        }).pipe(Effect.provide(layer)),
      )
      expect(result.response).toEqual(raw)
    }
  })
})
