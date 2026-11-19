import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, strictParseOptions } from '../schemas'
import {
  chartQuestionPolicy,
  buildChartJevRequest,
  chartAssessmentsFromBoxes,
  type ChartDecisionSource,
} from './chart-questions'
import { JevContractError } from './contract'

export const stagedChartQuestionPolicy = chartQuestionPolicy
export const makeInitialChartStageRequest = buildChartJevRequest

const StageResponse = Schema.Struct({ requestHash: Sha256Schema, responseHash: Sha256Schema, response: Schema.Unknown })
export const stagedChartAssessments = (source: ChartDecisionSource, input: unknown, baseStart: unknown = null) =>
  Result.gen(function* () {
    if (baseStart !== null)
      return yield* Result.fail(
        new JevContractError({ message: 'Box chart evidence cannot carry a second visual stage' }),
      )
    const prepared = yield* makeInitialChartStageRequest(source)
    const value = yield* Schema.decodeUnknownResult(StageResponse, strictParseOptions)(input)
    if (
      value.requestHash !== prepared.requestHash ||
      value.responseHash !== (yield* canonicalHashV1Result(value.response))
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Chart Box response differs from its source-bound request' }),
      )
    return yield* chartAssessmentsFromBoxes(source, value.response)
  })

export const makeFinancialChartStageReplay = () => ({ makeInitialChartStageRequest, stagedChartAssessments })
