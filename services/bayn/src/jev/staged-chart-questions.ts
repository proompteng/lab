import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, strictParseOptions } from '../schemas'
import {
  chartQuestionPolicy,
  buildChartJevRequest,
  chartAssessmentsFromBoxes,
  type ChartDecisionSource,
  type PreparedChartRequest,
} from './chart-questions'
import { JevContractError } from './contract'

export const stagedChartQuestionPolicy = chartQuestionPolicy
export const makeInitialChartStageRequest = buildChartJevRequest

const StageResponse = Schema.Struct({ requestHash: Sha256Schema, responseHash: Sha256Schema, response: Schema.Unknown })
export const assessPreparedChart = (source: ChartDecisionSource, prepared: PreparedChartRequest, input: unknown) =>
  Result.gen(function* () {
    const value = yield* Schema.decodeUnknownResult(StageResponse, strictParseOptions)(input)
    if (
      value.requestHash !== prepared.requestHash ||
      value.responseHash !== (yield* canonicalHashV1Result(value.response))
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Chart Box response differs from its source-bound request' }),
      )
    return yield* chartAssessmentsFromBoxes(source, prepared, value.response)
  })

export const stagedChartAssessments = (source: ChartDecisionSource, input: unknown, baseStart: unknown = null) =>
  Result.gen(function* () {
    if (baseStart !== null)
      return yield* Result.fail(
        new JevContractError({ message: 'Box chart evidence cannot carry a second visual stage' }),
      )
    return yield* assessPreparedChart(source, yield* makeInitialChartStageRequest(source), input)
  })

export const makeFinancialChartStageReplay = () => ({ makeInitialChartStageRequest, stagedChartAssessments })
