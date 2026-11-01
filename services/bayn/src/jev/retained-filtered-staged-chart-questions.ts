// Immutable chart stage reproduction for financial evidence from protocols v26 through v32.
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { chartQuestionPolicy, buildChartDecisionsRequest } from './retained-filtered-chart-questions'
import { chartAssessmentsFromResponse, type ChartDecisionSource } from './chart-questions'
import { JevContractError } from './contract'
import { decodeDecisionsResponse, prepareDecisionsRequest, type DecisionsRequest } from './decisions'

export const stagedChartQuestionPolicy = {
  ...chartQuestionPolicy,
  transport: 'funded-chart-then-selected-base-start.v2',
  predecessor: 'canonical-chart-request-and-response-hashes',
  skip: ['INSUFFICIENT_BARS', 'NO_ELIGIBLE_BASE', 'END_REFUSED', 'NO_BASE'],
} as const
export const makeInitialChartStageRequest = (source: ChartDecisionSource) => buildChartDecisionsRequest(source, 'CHART')

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
    if (!initial.request.questions.some((question) => question.name === 'base_last_bar'))
      return { status: 'NOT_REQUESTED' as const, reason: 'NO_ELIGIBLE_BASE' as const, predecessor }
    const answer = response.answers.find((value) => value.name === 'base_last_bar')
    if (answer?.type === 'refusal')
      return { status: 'NOT_REQUESTED' as const, reason: 'END_REFUSED' as const, predecessor }
    if (answer?.type === 'choice' && answer.choice === 'no_base')
      return { status: 'NOT_REQUESTED' as const, reason: 'NO_BASE' as const, predecessor }
    const end = chart.bars.slice(1, -1).find((bar) => answer?.type === 'choice' && bar.id === answer.choice)
    if (end === undefined)
      return yield* Result.fail(new JevContractError({ message: 'Selected base end is not an eligible source bar' }))
    const selected = yield* buildChartDecisionsRequest(source, { selectedEnd: end.id })
    if (selected.request.questions.length !== 1)
      return yield* Result.fail(new JevContractError({ message: 'Selected base end has no funded source intervals' }))
    const input = selected.request.input
    const prepared = yield* prepareDecisionsRequest({
      ...selected.request,
      input: [
        {
          ...input[0],
          content: [
            input[0].content[0],
            input[0].content[1],
            {
              type: 'input_json',
              data: { source: input[0].content[2].data, predecessor, selectedEnd: end.id },
            },
          ],
        },
      ],
    })
    return { status: 'PREPARED' as const, predecessor, selectedEnd: end.id, ...prepared }
  })

export const stagedChartAssessments = (source: ChartDecisionSource, initial: unknown, baseStart: unknown | null) =>
  Result.gen(function* () {
    const prepared = yield* makeInitialChartStageRequest(source)
    const chartResponse = yield* decodeBoundStageResponse(prepared, initial)
    const next = yield* selectedBaseStartFromChart(source, prepared, chartResponse)
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
        answers: [...chartResponse.response.answers, ...base.response.answers],
      },
      { ...prepared.request, questions: [...prepared.request.questions, ...next.request.questions] },
    )
  })

// Identity checks only: no claim that these bytes were dispatched, durably stored,
// paid for, or observed before a deadline. Integration must supply those proofs.
const StageResponse = Schema.Struct({ requestHash: Sha256Schema, responseHash: Sha256Schema, response: Schema.Unknown })
const decodeBoundStageResponse = (
  prepared: { readonly request: DecisionsRequest; readonly requestHash: string },
  input: unknown,
) =>
  Result.gen(function* () {
    const receipt = yield* Schema.decodeUnknownResult(
      StageResponse,
      strictParseOptions,
    )(input).pipe(
      Result.mapError((cause) => new JevContractError({ message: 'Invalid chart stage response identity', cause })),
    )
    const response = yield* decodeDecisionsResponse(prepared.request, receipt.response)
    const responseHash = yield* canonicalHashV1Result(response)
    if (receipt.requestHash !== prepared.requestHash || receipt.responseHash !== responseHash)
      return yield* Result.fail(
        new JevContractError({ message: 'Chart stage response does not match its source-bound request' }),
      )
    return { response, responseHash }
  })
