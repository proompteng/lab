import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Fiber, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, JevError } from './client'
import { decodeJevResponse, JevFailure, prepareJevRequest } from './contract'
import { DecisionsClient, DecisionsError, decodeDecisionsResponse, prepareDecisionsRequest } from './decisions'
import { EntryInferenceJournal, evaluateClaimedEntryInference, type EntryHandoff } from './entry-inference'
import { decodeEntryHandoff, decodeEntryInferenceCompletion } from './entry-inference-evidence'
import { prepareEntryInferenceInput } from './entry-inference-input'
import { entryEvaluationRequestFixture } from './entry-inference.test-support'
import { JevOutcome, makeJevEvaluationRequest, makeJevEvaluationReceipt, jevInferenceAvailableAt } from './evidence'
import { defaultJevProtocolDocument } from './protocol'

const at = Date.parse('2026-10-25T07:00:32.000Z')
const fixture = () => {
  const bars = [
    { minuteBeforeWindowEnd: 4, open: 100, high: 103, low: 97, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
  ]
  return {
    requestId: 'a'.repeat(64),
    observedAt: utcInstantFromEpochMillis(at),
    claimedAt: utcInstantFromEpochMillis(at),
    expiresAt: utcInstantFromEpochMillis(at + 10_000),
    input: {
      schemaVersion: 'bayn.entry-inference-input.v3' as const,
      numericalState: {
        schemaVersion: 'bayn.jev-entry-state.v22',
        task: { decisionPurpose: 'ENTRY' },
        candidate: { symbol: 'AAPL', bars1m: bars },
        benchmark: { symbol: 'SPY' },
        relativeSignals: {},
        session: { completedBarWindowEndsAt: '2026-10-25T07:00:00.000Z' },
      },
      chartSource: { symbol: 'AAPL', windowEndAt: '2026-10-25T07:00:00.000Z', bars },
      protocol: defaultJevProtocolDocument,
      funding: { bidMicros: '104000000', askMicros: '104020000', capitalMicros: '100000000000', cryptoFeeTier: null },
    },
  }
}

const providers = (
  options: {
    readonly visualDelay?: number
    readonly commitDelay?: number
    readonly jevDelay?: number
    readonly visualFailure?: boolean
    readonly jevFailure?: boolean
    readonly existingHandoff?: boolean
    readonly afterVisual?: () => void
  } = {},
) => {
  const events: string[] = []
  const handoffs: EntryHandoff[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(DecisionsClient, {
      evaluate: (input) =>
        Effect.gen(function* () {
          events.push('visual')
          const started = yield* Clock.currentTimeMillis
          const prepared = Result.getOrThrow(prepareDecisionsRequest(input))
          if (options.visualFailure)
            return yield* new DecisionsError({
              category: 'STATUS',
              message: 'Limited',
              status: 429,
              requestHash: prepared.requestHash,
              responseHash: 'b'.repeat(64),
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens: 0,
                total_tokens: 100,
              },
            })
          if (options.visualDelay !== undefined) yield* Effect.sleep(options.visualDelay)
          const anchors: Readonly<Record<string, number>> = {
            support_anchor: 0,
            resistance_anchor: 2,
            base_last_bar: 0,
          }
          const response = Result.getOrThrow(
            decodeDecisionsResponse(prepared.request, {
              model: prepared.request.model,
              answers: prepared.request.questions.map((question) =>
                question.type === 'predicate'
                  ? { type: 'predicate', name: question.name, probability: 0.8 }
                  : {
                      type: 'choice',
                      name: question.name,
                      choice: question.choices[anchors[question.name] ?? 0]?.value,
                      confidence: 0.8,
                      probabilities: question.choices.map((choice, index) => ({
                        value: choice.value,
                        probability: index === (anchors[question.name] ?? 0) ? 1 : 0,
                      })),
                    },
              ),
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens: 0,
                total_tokens: 100,
              },
            }),
          )
          options.afterVisual?.()
          return {
            requestHash: prepared.requestHash,
            responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
            startedAt: utcInstantFromEpochMillis(started),
            completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
            response,
          }
        }),
    }),
    Layer.succeed(EntryInferenceJournal, {
      recordHandoff: (handoff) =>
        Effect.gen(function* () {
          events.push('handoff')
          handoffs.push(handoff)
          const { handoffHash, ...material } = handoff
          expect(handoffHash).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
          if (options.commitDelay !== undefined) yield* Effect.sleep(options.commitDelay)
          return { dispatchAllowed: options.existingHandoff !== true }
        }),
    }),
    Layer.succeed(JevClient, {
      evaluate: (input) =>
        Effect.gen(function* () {
          expect(handoffs).toHaveLength(1)
          events.push('jev')
          const prepared = Result.getOrThrow(prepareJevRequest(input))
          if (options.jevFailure)
            return yield* new JevError({
              failure: JevFailure.Transport,
              message: 'Unavailable',
              requestHash: prepared.requestHash,
            })
          const started = yield* Clock.currentTimeMillis
          if (options.jevDelay !== undefined) yield* Effect.sleep(options.jevDelay)
          const response = Result.getOrThrow(
            decodeJevResponse(prepared.request, {
              model: prepared.request.model,
              answers: Object.fromEntries(
                Object.keys(prepared.request.questions).map((name) => [
                  name,
                  { type: 'noul', noul: name.endsWith('_target_obstructed') ? 0.1 : 0.9 },
                ]),
              ),
              usage: { input_tokens: 200, output_tokens: 0 },
            }),
          )
          return {
            requestHash: prepared.requestHash,
            responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
            startedAt: utcInstantFromEpochMillis(started),
            completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
            response,
          }
        }),
    }),
  )
  return { events, handoffs, layer }
}

const run = (
  claim: Parameters<typeof evaluateClaimedEntryInference>[0],
  setup: ReturnType<typeof providers>,
  advance = 0,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const fiber = yield* evaluateClaimedEntryInference(claim).pipe(Effect.result, Effect.forkChild)
      if (advance > 0) yield* TestClock.adjust(advance)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )

describe('claimed sequential entry inference', () => {
  test('commits a source-infeasible result before either provider is dispatched', async () => {
    const claim = fixture()
    const input = {
      ...claim.input,
      funding: { ...claim.input.funding, bidMicros: '500000000', askMicros: '500020000' },
    }
    const setup = providers()
    const result = Result.getOrThrow(await run({ ...claim, input }, setup))
    expect(setup.events).toEqual(['handoff'])
    expect(result.handoff.disposition).toEqual({ status: 'SOURCE_INFEASIBLE' })
    expect(result.jev).toEqual({ status: 'NOT_REQUESTED' })
    expect(Result.isSuccess(decodeEntryInferenceCompletion({ ...claim, input }, result))).toBe(true)
  })

  test('rejects a resealed infeasibility claim when the source can fund a proposal', async () => {
    const claim = fixture()
    const result = Result.getOrThrow(await run(claim, providers()))
    const { handoffHash: _, ...original } = result.handoff
    const material = { ...original, disposition: { status: 'SOURCE_INFEASIBLE' } }
    const changed = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
    expect(Result.isFailure(decodeEntryHandoff(claim, changed))).toBe(true)
  })

  test('retains skip accounting after a late commit without extending entry validity', async () => {
    const { requestId: _requestId, ...original } = entryEvaluationRequestFixture(utcInstantFromEpochMillis(at))
    const prepared = Result.getOrThrow(
      prepareEntryInferenceInput({
        ...original.request,
        funding: { ...original.request.funding, bidMicros: '500000000', askMicros: '500020000' },
      }),
    )
    const request = Result.getOrThrow(
      makeJevEvaluationRequest({ ...original, request: prepared.input, requestHash: prepared.requestHash }),
    )
    const claim = {
      requestId: request.requestId,
      input: request.request,
      observedAt: request.observedAt,
      expiresAt: request.expiresAt,
      claimedAt: request.observedAt,
    }
    const setup = providers({ commitDelay: 10_001 })
    const result = Result.getOrThrow(await run(claim, setup, 10_001))
    expect(setup.events).toEqual(['handoff'])
    expect(Result.isSuccess(decodeEntryInferenceCompletion(claim, result))).toBe(true)
    const receipt = Result.getOrThrow(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v2',
        requestId: request.requestId,
        startedAt: request.observedAt,
        completedAt: result.completedAt,
        outcome: { status: JevOutcome.Completed, completion: result },
      }),
    )
    expect(Result.isFailure(jevInferenceAvailableAt(request, receipt, at + 10_001))).toBe(true)
  })

  test('does not dispatch providers or replace an existing source-infeasible handoff', async () => {
    const original = fixture()
    const claim = {
      ...original,
      input: {
        ...original.input,
        funding: { ...original.input.funding, bidMicros: '500000000', askMicros: '500020000' },
      },
    }
    const setup = providers({ existingHandoff: true })
    expect(Result.isFailure(await run(claim, setup))).toBe(true)
    expect(setup.events).toEqual(['handoff'])
  })

  test('rejects a position-management purpose without dispatching entry providers', async () => {
    const claim = fixture()
    const setup = providers()
    const input = {
      ...claim.input,
      numericalState: { ...claim.input.numericalState, task: { decisionPurpose: 'MANAGE' } },
    }
    expect(Result.isFailure(await run({ ...claim, input }, setup))).toBe(true)
    expect(setup.events).toEqual([])
  })
  test('rejects a chart window from after the original observation without provider dispatch', async () => {
    const claim = fixture()
    const setup = providers()
    const windowEndAt = '2026-10-25T07:01:00.000Z'
    const input = {
      ...claim.input,
      chartSource: { ...claim.input.chartSource, windowEndAt },
      numericalState: { ...claim.input.numericalState, session: { completedBarWindowEndsAt: windowEndAt } },
    }
    expect(Result.isFailure(await run({ ...claim, input }, setup))).toBe(true)
    expect(setup.events).toEqual([])
  })
  test('feeds chart assessments into the exact Jev request after committing its handoff', async () => {
    const setup = providers()
    const claim = fixture()
    const result = Result.getOrThrow(await run(claim, setup))
    expect(Result.isSuccess(decodeEntryInferenceCompletion(claim, result))).toBe(true)
    expect(setup.events).toEqual(['visual', 'handoff', 'jev'])
    expect(result.handoff.disposition.status).toBe('READY')
    expect(result.jev.status).toBe('RECEIVED')
    if (result.handoff.disposition.status === 'READY' && result.jev.status === 'RECEIVED')
      expect(result.jev.inference.requestHash).toBe(result.handoff.disposition.jevRequestHash)
  })

  test('rejects resealed changes to the dependent Jev request', async () => {
    const claim = fixture()
    const result = Result.getOrThrow(await run(claim, providers()))
    const disposition = result.handoff.disposition
    if (disposition.status !== 'READY') throw new Error('Expected dependent request')
    const changedRequest = { ...disposition.jevRequest, state: { candidate: { symbol: 'AAPL', invented: true } } }
    const changedDisposition = {
      ...disposition,
      jevRequest: changedRequest,
      jevRequestHash: Result.getOrThrow(canonicalHashV1Result(changedRequest)),
    }
    const { handoffHash: _, ...original } = result.handoff
    const material = { ...original, disposition: changedDisposition }
    const changed = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
    expect(Result.isFailure(decodeEntryHandoff(claim, changed))).toBe(true)
  })

  test('rejects a dependent inference linked to a different request', async () => {
    const claim = fixture()
    const result = Result.getOrThrow(await run(claim, providers()))
    if (result.jev.status !== 'RECEIVED') throw new Error('Expected dependent inference')
    expect(
      Result.isFailure(
        decodeEntryInferenceCompletion(claim, {
          ...result,
          jev: { ...result.jev, inference: { ...result.jev.inference, requestHash: 'f'.repeat(64) } },
        }),
      ),
    ).toBe(true)
  })

  test('retains late completion evidence for accounting with its original deadline', async () => {
    const claim = fixture()
    const result = Result.getOrThrow(await run(claim, providers()))
    const completed = Result.getOrThrow(
      decodeEntryInferenceCompletion(claim, { ...result, completedAt: utcInstantFromEpochMillis(at + 10_001) }),
    )
    expect(Date.parse(completed.completedAt)).toBeGreaterThan(Date.parse(claim.expiresAt))
    expect(completed.handoff).toEqual(result.handoff)
  })

  test('keeps observed visual costs when the subsequent provider fails', async () => {
    const setup = providers({ jevFailure: true })
    const result = Result.getOrThrow(await run(fixture(), setup))
    expect(result.jev).toMatchObject({ status: 'FAILED', failure: JevFailure.Transport, usage: null })
    expect(result.handoff.disposition).toMatchObject({
      status: 'READY',
      visual: { response: { usage: { input_tokens: 100 } } },
    })
  })

  test('records a metered visual failure without calling Jev', async () => {
    const setup = providers({ visualFailure: true })
    const result = Result.getOrThrow(await run(fixture(), setup))
    expect(setup.events).toEqual(['visual', 'handoff'])
    expect(result.jev.status).toBe('NOT_REQUESTED')
    expect(result.handoff.disposition).toMatchObject({
      status: 'VISUAL_FAILED',
      failure: { httpStatus: 429, usage: { input_tokens: 100 } },
    })
  })

  test('does not renew the deadline after chart inference or handoff persistence', async () => {
    const setup = providers({ visualDelay: 2_000, commitDelay: 8_001 })
    const result = Result.getOrThrow(await run(fixture(), setup, 10_001))
    expect(setup.events).toEqual(['visual', 'handoff'])
    expect(result.jev.status).toBe('NOT_DISPATCHED')
  })

  test('bounds the second provider by the remainder of the original evidence window', async () => {
    const setup = providers({ visualDelay: 8_000, jevDelay: 3_000 })
    const result = Result.getOrThrow(await run(fixture(), setup, 11_000))
    expect(setup.events).toEqual(['visual', 'handoff', 'jev'])
    expect(result.jev).toMatchObject({ status: 'FAILED', failure: JevFailure.Timeout, usage: null })
  })

  test('does not repeat Jev dispatch when the handoff was already claimed', async () => {
    const setup = providers({ existingHandoff: true })
    const result = await run(fixture(), setup)
    expect(Result.isFailure(result)).toBe(true)
    expect(setup.events).toEqual(['visual', 'handoff'])
  })

  test('detaches numerical and chart evidence before yielding to either provider', async () => {
    const claim = fixture()
    const setup = providers({
      afterVisual: () => {
        const first = claim.input.chartSource.bars[0]
        if (first !== undefined) first.close = 1_000
      },
    })
    const result = Result.getOrThrow(await run(claim, setup))
    expect(result.handoff.disposition.status).toBe('READY')
    if (result.handoff.disposition.status === 'READY')
      expect(result.handoff.disposition.jevRequest.state).toMatchObject({
        candidate: { bars1m: [{ close: 101 }, { close: 100 }, { close: 104 }, { close: 104 }] },
      })
  })
})
