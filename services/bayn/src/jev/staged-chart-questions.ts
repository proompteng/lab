import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, strictParseOptions } from '../schemas'
import {
  chartQuestionPolicy,
  chartAssessmentsFromResponse,
  buildChartJevRequest,
  type ChartDecisionSource,
} from './chart-questions'
import { JevContractError, decodeJevResponse, prepareJevRequest, type JevRequest } from './contract'
import { chartPresenceIsAbsent } from './judgment-policy'

export const stagedChartQuestionPolicy = {
  ...chartQuestionPolicy,
  transport: 'jev-chart-then-selected-base-start.v1',
  predecessor: 'canonical-chart-request-and-response-hashes',
  skip: ['INSUFFICIENT_BARS', 'NO_ELIGIBLE_BASE', 'END_REFUSED', 'NO_BASE'],
} as const
export const makeInitialChartStageRequest = (source: ChartDecisionSource) => buildChartJevRequest(source, 'CHART')

export const makeSelectedBaseStartStageRequest = (source: ChartDecisionSource, initialResponse: unknown) =>
  Result.gen(function* () {
    const initial = yield* makeInitialChartStageRequest(source)
    const decoded = yield* decodeBoundStageResponse(initial, initialResponse)
    return yield* selectedBaseStartFromChart(source, initial, decoded)
  })

// Private to the two raw-input boundaries below: reuse only the initial request
// and response they have already reproduced together in this invocation.
const selectedBaseStartFromChart = (
  source: ChartDecisionSource,
  initial: Result.Result.Success<ReturnType<typeof makeInitialChartStageRequest>>,
  decoded: Result.Result.Success<ReturnType<typeof decodeBoundStageResponse>>,
) =>
  Result.gen(function* () {
    const { chart } = source
    const { response, responseHash } = decoded
    const predecessor = { requestHash: initial.requestHash, responseHash }
    if (chart.bars.length < 3)
      return { status: 'NOT_REQUESTED' as const, reason: 'INSUFFICIENT_BARS' as const, predecessor }
    if (!('base_last_bar' in initial.request.questions))
      return { status: 'NOT_REQUESTED' as const, reason: 'NO_ELIGIBLE_BASE' as const, predecessor }
    const answer = response.answers['base_last_bar']
    const presence = response.answers['base_present']
    if (
      (presence?.type === 'noul' && chartPresenceIsAbsent(source.protocol, presence.noul)) ||
      (answer?.type === 'choice' && answer.choice === 'no_base')
    )
      return { status: 'NOT_REQUESTED' as const, reason: 'NO_BASE' as const, predecessor }
    const end = chart.bars.slice(1, -1).find((bar) => answer?.type === 'choice' && bar.id === answer.choice)
    if (end === undefined)
      return yield* Result.fail(new JevContractError({ message: 'Selected base end is not an eligible source bar' }))
    const selected = yield* buildChartJevRequest(source, { selectedEnd: end.id })
    if (Object.keys(selected.request.questions).length !== 1)
      return yield* Result.fail(new JevContractError({ message: 'Selected base end has no eligible source intervals' }))
    const prepared = yield* prepareJevRequest({
      ...selected.request,
      state: { source: selected.request.state, predecessor, selectedEnd: end.id },
    })
    return { status: 'PREPARED' as const, predecessor, selectedEnd: end.id, ...prepared }
  })

export const decodeSelectedBaseStartStageResponse = (
  source: ChartDecisionSource,
  initialResponse: unknown,
  input: unknown,
) =>
  Result.gen(function* () {
    const stage = yield* makeSelectedBaseStartStageRequest(source, initialResponse)
    if (stage.status !== 'PREPARED')
      return yield* Result.fail(
        new JevContractError({ message: 'Base start response has no requested predecessor stage' }),
      )
    const decoded = yield* decodeBoundStageResponse(stage, input)
    return { requestHash: stage.requestHash, predecessor: stage.predecessor, ...decoded }
  })

export const stagedChartAssessments = (source: ChartDecisionSource, initial: unknown, baseStart: unknown | null) =>
  Result.gen(function* () {
    const prepared = yield* makeInitialChartStageRequest(source)
    const chartResponse = yield* decodeBoundStageResponse(prepared, initial)
    const next = yield* selectedBaseStartFromChart(source, prepared, chartResponse)
    return yield* assessmentsFromPreparedStages(source, prepared, chartResponse, next, baseStart)
  })

const assessmentsFromPreparedStages = (
  source: ChartDecisionSource,
  prepared: Result.Result.Success<ReturnType<typeof makeInitialChartStageRequest>>,
  chartResponse: Result.Result.Success<ReturnType<typeof decodeBoundStageResponse>>,
  next: Result.Result.Success<ReturnType<typeof selectedBaseStartFromChart>>,
  baseStart: unknown | null,
) =>
  Result.gen(function* () {
    if (next.status === 'NOT_REQUESTED') {
      if (baseStart !== null)
        return yield* Result.fail(new JevContractError({ message: 'Skipped base start has unexpected response' }))
      return yield* chartAssessmentsFromResponse(source.chart, chartResponse.response, prepared.request)
    }
    const base = yield* decodeBoundStageResponse(next, baseStart)
    // Combine only validated answers for pure structural derivation. This is not a
    // fabricated provider receipt: both original receipts remain separate evidence.
    return yield* chartAssessmentsFromResponse(
      source.chart,
      {
        ...chartResponse.response,
        answers: { ...chartResponse.response.answers, ...base.response.answers },
      },
      { ...prepared.request, questions: { ...prepared.request.questions, ...next.request.questions } },
    )
  })

/** One synchronous financial evidence decode owns this replay; never retain it across requests. */
export const makeFinancialChartStageReplay = () => {
  let initialCache:
    | { readonly key: string; readonly value: Result.Result.Success<ReturnType<typeof makeInitialChartStageRequest>> }
    | undefined
  const initial = (source: ChartDecisionSource) =>
    Result.gen(function* () {
      const key = yield* canonicalHashV1Result(source).pipe(
        Result.mapError(
          (cause) => new JevContractError({ message: 'Financial chart replay source is malformed', cause }),
        ),
      )
      if (initialCache?.key === key) return initialCache.value
      const value = yield* makeInitialChartStageRequest(source)
      initialCache = { key, value }
      return value
    })
  const prepareSelected = (source: ChartDecisionSource, response: unknown) =>
    Result.gen(function* () {
      const prepared = yield* initial(source)
      const chartResponse = yield* decodeBoundStageResponse(prepared, response)
      const next = yield* selectedBaseStartFromChart(source, prepared, chartResponse)
      return { prepared, chartResponse, next }
    })
  let selectedCache:
    | { readonly key: string; readonly value: Result.Result.Success<ReturnType<typeof prepareSelected>> }
    | undefined
  const selected = (source: ChartDecisionSource, response: unknown) =>
    Result.gen(function* () {
      // Include actual source and response bytes, not only their claimed hashes.
      const key = yield* canonicalHashV1Result({ source, response }).pipe(
        Result.mapError(
          (cause) => new JevContractError({ message: 'Financial chart replay response is malformed', cause }),
        ),
      )
      if (selectedCache?.key === key) return selectedCache.value
      const value = yield* prepareSelected(source, response)
      selectedCache = { key, value }
      return value
    })
  return {
    makeInitialChartStageRequest: initial,
    makeSelectedBaseStartStageRequest: (source: ChartDecisionSource, response: unknown) =>
      selected(source, response).pipe(Result.map(({ next }) => next)),
    stagedChartAssessments: (source: ChartDecisionSource, response: unknown, baseStart: unknown | null) =>
      selected(source, response).pipe(
        Result.flatMap(({ prepared, chartResponse, next }) =>
          assessmentsFromPreparedStages(source, prepared, chartResponse, next, baseStart),
        ),
      ),
  }
}

// Identity checks only: no claim that these bytes were dispatched, durably stored,
// paid for, or observed before a deadline. Integration must supply those proofs.
const StageResponse = Schema.Struct({ requestHash: Sha256Schema, responseHash: Sha256Schema, response: Schema.Unknown })
const decodeBoundStageResponse = (
  prepared: { readonly request: JevRequest; readonly requestHash: string },
  input: unknown,
) =>
  Result.gen(function* () {
    const receipt = yield* Schema.decodeUnknownResult(
      StageResponse,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => new JevContractError({ message: 'Invalid chart stage response identity', cause })),
    )
    const response = yield* decodeJevResponse(prepared.request, receipt.response)
    const responseHash = yield* canonicalHashV1Result(response)
    if (receipt.requestHash !== prepared.requestHash || receipt.responseHash !== responseHash)
      return yield* Result.fail(
        new JevContractError({ message: 'Chart stage response does not match its source-bound request' }),
      )
    return { response, responseHash }
  })
