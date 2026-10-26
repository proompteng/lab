import { Clock, Effect, Layer, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { operationalError } from '../errors'
import { makeNativeChartEvidence } from './chart-evidence'
import { makeChartDecisionsRequest } from './chart-questions'
import { decodeJevResponse, prepareJevRequest } from './contract'
import { DecisionsClient, decodeDecisionsResponse, prepareDecisionsRequest } from './decisions'
import { utcInstantFromEpochMillis } from '../time'
import { EntryInferenceJournal, deriveEntryHandoffDisposition, type EntryInferenceCompletion } from './entry-inference'
import type { EntryInferenceInput } from './entry-inference-input'
import { makeJevEvaluationRequest, type JevEvaluationRequest } from './evidence'
import { prepareEntryInferenceInput } from './entry-inference-input'
import { defaultJevProtocolDocument } from './protocol'

export const entryEvaluationRequestFixture = (observedAt = '2026-10-25T07:00:32.000Z', symbol = 'AAPL') => {
  const windowEndAt = new Date(Math.floor(Date.parse(observedAt) / 60_000) * 60_000).toISOString()
  const bars = [
    { minuteBeforeWindowEnd: 4, open: 100, high: 103, low: 97, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
  ]
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      schemaVersion: 'bayn.entry-inference-input.v4',
      numericalState: {
        schemaVersion: 'bayn.jev-entry-state.v22',
        task: { decisionPurpose: 'ENTRY' },
        candidate: { symbol, bars1m: bars },
        session: { completedBarWindowEndsAt: windowEndAt },
      },
      chartSource: { symbol, windowEndAt, bars },
      protocol: defaultJevProtocolDocument,
      funding: { bidMicros: '104000000', askMicros: '104020000', capitalMicros: '100000000000', cryptoFeeTier: null },
    }),
  )
  return Result.getOrThrow(
    makeJevEvaluationRequest({
      schemaVersion: 'bayn.jev-evaluation-request.v2',
      cycleId: 'a'.repeat(64),
      authorityGenerationHash: 'b'.repeat(64),
      snapshotId: 'c'.repeat(64),
      symbol,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + defaultJevProtocolDocument.inferenceValidityMs).toISOString(),
      request: prepared.input,
      requestHash: prepared.requestHash,
    }),
  )
}

export const chartInferenceFixture = (input: EntryInferenceInput, at: string) => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(input.chartSource))
  const prepared = Result.getOrThrow(
    makeChartDecisionsRequest({ chart, protocol: input.protocol, funding: input.funding }),
  )
  return nativeChartInference(prepared.request, at)
}

export const nativeChartInference = (raw: unknown, at: string) => {
  const prepared = Result.getOrThrow(prepareDecisionsRequest(raw))
  const source = Schema.decodeUnknownSync(
    Schema.Struct({
      bars: Schema.Array(Schema.Struct({ id: Schema.String, low: Schema.Number, high: Schema.Number })).check(
        Schema.isMinLength(1),
      ),
    }),
  )(prepared.request.input[0].content[2].data)
  const response = Result.getOrThrow(
    decodeDecisionsResponse(prepared.request, {
      model: prepared.request.model,
      answers: prepared.request.questions.map((question) => {
        if (question.type === 'predicate') return { type: 'predicate', name: question.name, probability: 0.9 }
        const offered = source.bars.filter((bar) => question.choices.some((choice) => choice.value === bar.id))
        const anchor = question.name.startsWith('base_first_bar_ending_')
          ? offered[0]
          : question.name === 'base_last_bar'
            ? offered.at(-1)
            : offered.reduce<(typeof offered)[number] | undefined>(
                (selected, bar) =>
                  selected === undefined ||
                  (question.name === 'support_anchor' ? bar.low < selected.low : bar.high > selected.high)
                    ? bar
                    : selected,
                undefined,
              )
        if (anchor === undefined) throw new Error('Missing fixture chart anchor')
        return {
          type: 'choice',
          name: question.name,
          choice: anchor.id,
          confidence: 1,
          probabilities: question.choices.map((choice) => ({
            value: choice.value,
            probability: choice.value === anchor.id ? 1 : 0,
          })),
        }
      }),
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        total_tokens: 100,
      },
    }),
  )
  return {
    requestHash: prepared.requestHash,
    responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
    startedAt: at,
    completedAt: at,
    response,
  }
}

export const chartProviderFixture: DecisionsClient['Service'] = {
  evaluate: (raw) =>
    Clock.currentTimeMillis.pipe(Effect.map((at) => nativeChartInference(raw, utcInstantFromEpochMillis(at)))),
}

export const entryInferenceFixtureLayer = Layer.mergeAll(
  Layer.succeed(DecisionsClient, chartProviderFixture),
  Layer.sync(EntryInferenceJournal, () => {
    const saved = new Map<string, string>()
    const claims = new Map<string, string>()
    return {
      recordChartClaim: (claim) =>
        Effect.sync(() => {
          const prior = claims.get(claim.requestId)
          claims.set(claim.requestId, claim.claimHash)
          return { dispatchAllowed: prior === undefined }
        }),
      recordChartTerminal: () => Effect.void,
      recordHandoff: (handoff) =>
        Effect.suspend(() => {
          const previous = saved.get(handoff.requestId)
          if (previous !== undefined && previous !== handoff.handoffHash)
            return Effect.fail(
              operationalError({
                component: 'database',
                operation: 'test-handoff',
                message: 'Fixture handoff is immutable',
              }),
            )
          saved.set(handoff.requestId, handoff.handoffHash)
          return Effect.succeed({ dispatchAllowed: previous === undefined })
        }),
    }
  }),
)

export const entryCompletionFixture = (
  request: JevEvaluationRequest,
  at = request.observedAt,
  support = 0.9,
): EntryInferenceCompletion => {
  const disposition = Result.getOrThrow(
    deriveEntryHandoffDisposition(request.request, chartInferenceFixture(request.request, at)),
  )
  const material = {
    schemaVersion: 'bayn.entry-handoff.v3' as const,
    requestId: request.requestId,
    inputHash: request.requestHash,
    visualRequestHash: disposition.visual.requestHash,
    recordedAt: at,
    disposition,
  }
  const handoff = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  if (disposition.status !== 'READY') return { handoff, completedAt: at, jev: { status: 'NOT_REQUESTED' } }
  const prepared = Result.getOrThrow(prepareJevRequest(disposition.jevRequest))
  const response = Result.getOrThrow(
    decodeJevResponse(prepared.request, {
      model: prepared.request.model,
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((name) => [
          name,
          { type: 'noul', noul: name.endsWith('_target_obstructed') ? 1 - support : support },
        ]),
      ),
      usage: { input_tokens: 200, output_tokens: 0 },
    }),
  )
  return {
    handoff,
    completedAt: at,
    jev: {
      status: 'RECEIVED',
      inference: {
        requestHash: prepared.requestHash,
        responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
        startedAt: at,
        completedAt: at,
        response,
      },
    },
  }
}
