import { Clock, Effect, Layer, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { operationalError } from '../errors'
import { makeNativeChartEvidence } from './chart-evidence'
import {
  makeInitialChartStageRequest,
  makeSelectedBaseStartStageRequest,
  stagedChartAssessments,
} from './staged-chart-questions'
import type { ChartDecisionSource } from './chart-questions'
import {
  makeStagedDispatchClaim,
  makeStagedTerminalReceipt,
  makeStagedSkipReceipt,
  stageResponseIdentity,
  type StagedCheckpoint,
} from './staged-checkpoint'
import { decodeJevResponse, prepareJevRequest } from './contract'
import { DecisionsClient, decodeDecisionsResponse, prepareDecisionsRequest } from './decisions'
import { utcInstantFromEpochMillis } from '../time'
import { EntryInferenceJournal, deriveEntryHandoffDisposition, type EntryInferenceCompletion } from './entry-inference'
import type { EntryInferenceInput, EntryInferenceMaterial } from './entry-inference-input'
import { makeJevEvaluationRequest, type JevEvaluationRequest } from './evidence'
import { EntryAblationSelection, prepareEntryInferenceInput } from './entry-inference-input'
import { defaultJevProtocolDocument } from './protocol'

export const entryEvaluationRequestFixture = (
  observedAt = '2026-10-25T07:00:32.000Z',
  symbol = 'AAPL',
  selectionPolicy?: EntryAblationSelection,
) => {
  const windowEndAt = new Date(Math.floor(Date.parse(observedAt) / 60_000) * 60_000).toISOString()
  const bars = [
    { minuteBeforeWindowEnd: 4, open: 100, high: 103, low: 97, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
  ]
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...(selectionPolicy === undefined
        ? { schemaVersion: 'bayn.entry-inference-input.v6' }
        : { schemaVersion: 'bayn.entry-ablation-input.v1', selectionPolicy }),
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
      schemaVersion: 'bayn.jev-evaluation-request.v3',
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
    makeInitialChartStageRequest({ chart, protocol: input.protocol, funding: input.funding }),
  )
  return nativeChartInference(prepared.request, at)
}

export const nativeChartInference = (raw: unknown, at: string) => {
  const prepared = Result.getOrThrow(prepareDecisionsRequest(raw))
  const rawSource = prepared.request.input[0].content[2].data
  const source = Schema.decodeUnknownSync(
    Schema.Struct({
      bars: Schema.Array(Schema.Struct({ id: Schema.String, low: Schema.Number, high: Schema.Number })).check(
        Schema.isMinLength(1),
      ),
    }),
  )(typeof rawSource === 'object' && rawSource !== null && 'source' in rawSource ? rawSource['source'] : rawSource)
  const response = Result.getOrThrow(
    decodeDecisionsResponse(prepared.request, {
      model: prepared.request.model,
      answers: prepared.request.questions.map((question) => {
        if (question.type === 'predicate') return { type: 'predicate', name: question.name, probability: 0.9 }
        const eligible = source.bars.filter((bar) => question.choices.some((choice) => choice.value === bar.id))
        const anchor =
          question.name === 'support_anchor'
            ? eligible.reduce<(typeof eligible)[number] | undefined>(
                (left, right) => (left === undefined || right.low < left.low ? right : left),
                undefined,
              )
            : question.name === 'resistance_anchor'
              ? eligible.reduce<(typeof eligible)[number] | undefined>(
                  (left, right) => (left === undefined || right.high > left.high ? right : left),
                  undefined,
                )
              : question.name === 'base_last_bar'
                ? eligible.at(-1)
                : eligible[0]
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

export const chartAssessmentsFixture = (source: ChartDecisionSource, at = source.chart.windowEndAt) => {
  const initial = Result.getOrThrow(makeInitialChartStageRequest(source))
  const chart = nativeChartInference(initial.request, at)
  const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(source, stageResponseIdentity(chart)))
  const baseStart = next.status === 'PREPARED' ? nativeChartInference(next.request, at) : null
  return Result.getOrThrow(
    stagedChartAssessments(
      source,
      stageResponseIdentity(chart),
      baseStart === null ? null : stageResponseIdentity(baseStart),
    ),
  )
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
    const recordHandoff = (handoff: import('./entry-inference').EntryHandoff) =>
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
      })
    const recordClaim = (claim: import('./staged-checkpoint').StagedDispatchClaim) =>
      Effect.sync(() => {
        const key = `${claim.requestId}:${claim.stage}`
        const prior = claims.get(key)
        claims.set(key, claim.claimHash)
        return { dispatchAllowed: prior === undefined }
      })
    const journal: typeof EntryInferenceJournal.Service = {
      recordVisualClaims: (inputs) =>
        Effect.forEach(inputs, (claim) =>
          recordClaim(claim).pipe(Effect.map((result) => ({ requestId: claim.requestId, ...result }))),
        ),
      recordTransitions: (inputs) =>
        Effect.forEach(inputs, (input) =>
          Effect.gen(function* () {
            const requestId = input.terminal === null ? input.successor.handoff.requestId : input.terminal.requestId
            const successor = input.successor
            const result =
              successor.kind === 'NONE'
                ? { dispatchAllowed: false }
                : successor.kind === 'VISUAL'
                  ? yield* recordClaim(successor.claim)
                  : yield* recordHandoff(successor.handoff)
            return { requestId, ...result }
          }),
        ),
    }
    return journal
  }),
)

export const entryCompletionFixture = (
  request: JevEvaluationRequest,
  at = request.observedAt,
  support = 0.9,
): EntryInferenceCompletion => {
  const checkpoint = stagedCheckpointFixture(request, at)
  const chart = checkpoint.terminals.find((row) => row.stage === 'CHART')
  if (chart?.outcome.status !== 'RECEIVED') throw new Error('Expected fixture chart response')
  const base = checkpoint.terminals.find((row) => row.stage === 'BASE_START')
  const skip = checkpoint.skips[0]
  const baseStart = base?.outcome ?? (skip === undefined ? null : { status: 'NOT_REQUESTED' as const, skip })
  if (baseStart === null) throw new Error('Expected fixture base outcome')
  const disposition = Result.getOrThrow(
    deriveEntryHandoffDisposition(
      request.request,
      chart.outcome.inference,
      baseStart.status === 'RECEIVED' ? baseStart.inference : null,
    ),
  )
  const material = {
    schemaVersion: 'bayn.entry-handoff.v4' as const,
    requestId: request.requestId,
    inputHash: request.requestHash,
    visualRequestHash: disposition.visual.requestHash,
    recordedAt: at,
    disposition,
    baseStart,
  }

  const handoff = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  if (disposition.status !== 'READY') return { handoff, completedAt: at, jev: { status: 'NOT_REQUESTED' } }
  if (request.request.schemaVersion === 'bayn.entry-ablation-input.v1')
    return { handoff, completedAt: at, jev: { status: 'OMITTED_BY_POLICY' } }
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

export const stagedCheckpointFixture = (
  request: Pick<JevEvaluationRequest, 'requestId' | 'observedAt' | 'expiresAt'> & {
    readonly request: EntryInferenceMaterial
  },
  at = request.observedAt,
): StagedCheckpoint => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
  const initial = Result.getOrThrow(
    makeInitialChartStageRequest({ chart, protocol: request.request.protocol, funding: request.request.funding }),
  )
  const claim = Result.getOrThrow(
    makeStagedDispatchClaim({
      schemaVersion: 'bayn.staged-dispatch-claim.v1',
      stage: 'CHART',
      requestId: request.requestId,
      providerRequestHash: initial.requestHash,
      predecessorHash: null,
      selectedEnd: null,
      claimedAt: at,
      expiresAt: request.expiresAt,
    }),
  )
  const visual = nativeChartInference(initial.request, at)
  const terminal = Result.getOrThrow(
    makeStagedTerminalReceipt({
      schemaVersion: 'bayn.staged-terminal-receipt.v1',
      stage: 'CHART',
      requestId: request.requestId,
      claimHash: claim.claimHash,
      recordedAt: at,
      outcome: { status: 'RECEIVED', inference: visual },
    }),
  )
  const next = Result.getOrThrow(
    makeSelectedBaseStartStageRequest(
      { chart, protocol: request.request.protocol, funding: request.request.funding },
      stageResponseIdentity(visual),
    ),
  )
  if (next.status === 'NOT_REQUESTED') {
    const skip = Result.getOrThrow(
      makeStagedSkipReceipt({
        schemaVersion: 'bayn.staged-skip-receipt.v1',
        stage: 'BASE_START',
        requestId: request.requestId,
        predecessorHash: terminal.terminalHash,
        reason: next.reason,
        recordedAt: at,
      }),
    )
    return { claims: [claim], terminals: [terminal], skips: [skip] }
  }
  const baseClaim = Result.getOrThrow(
    makeStagedDispatchClaim({
      schemaVersion: 'bayn.staged-dispatch-claim.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      providerRequestHash: next.requestHash,
      predecessorHash: terminal.terminalHash,
      selectedEnd: next.selectedEnd,
      claimedAt: at,
      expiresAt: request.expiresAt,
    }),
  )
  const baseTerminal = Result.getOrThrow(
    makeStagedTerminalReceipt({
      schemaVersion: 'bayn.staged-terminal-receipt.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      claimHash: baseClaim.claimHash,
      recordedAt: at,
      outcome: { status: 'RECEIVED', inference: nativeChartInference(next.request, at) },
    }),
  )
  return { claims: [claim, baseClaim], terminals: [terminal, baseTerminal], skips: [] }
}
