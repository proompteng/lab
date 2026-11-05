import { Result, Schema } from 'effect'
import {
  JevContractError,
  JevInferenceSchema,
  JevResponseSchema,
  decodeJevResponse,
  type JevRequest,
  type JevResponse,
} from './contract'
import {
  DecisionsInferenceSchema,
  DecisionsUsageSchema,
  decodeDecisionsResponse,
  validDecisionsUsage,
  type DecisionsRequest,
  type DecisionsResponse,
  type DecisionsError,
} from './decisions'

// Retired OpenAI receipts remain financial evidence; only the current protocol admits new dispatch.
export const ChartStageInferenceSchema = Schema.Union([JevInferenceSchema, DecisionsInferenceSchema])
export const ChartStageUsageSchema = Schema.Union([JevResponseSchema.fields.usage, DecisionsUsageSchema])
export const validChartStageUsage = (usage: typeof ChartStageUsageSchema.Type) =>
  'input_tokens_details' in usage ? validDecisionsUsage(usage) : true
export const decodeChartStageResponse = (
  request: JevRequest | DecisionsRequest,
  response: unknown,
): Result.Result<JevResponse | DecisionsResponse, JevContractError | DecisionsError> =>
  request.model === 'jev-1.13.0' ? decodeJevResponse(request, response) : decodeDecisionsResponse(request, response)
