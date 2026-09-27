import { Result, Schema } from 'effect'

import {
  decodeRuneResponse,
  prepareRuneRequest,
  runeModel,
  RuneRequestSchema,
  RuneResponseSchema,
  type RuneContractError,
} from '../rune/contract'
import { strictParseOptions } from '../schemas'
import { decodeJevResponse, JevContractError, JevRequestSchema, JevResponseSchema, prepareJevRequest } from './contract'

// Persisted Jev records keep their original bytes and hashes; only Rune has an active transport.
export const RetainedDecisionRequestSchema = Schema.Union([JevRequestSchema, RuneRequestSchema])
export const RetainedDecisionResponseSchema = Schema.Union([JevResponseSchema, RuneResponseSchema])
export type RetainedDecisionRequest = typeof RetainedDecisionRequestSchema.Type
export type RetainedDecisionResponse = typeof RetainedDecisionResponseSchema.Type

export const prepareRetainedDecisionRequest = (
  input: unknown,
): Result.Result<
  {
    readonly request: RetainedDecisionRequest
    readonly requestHash: string
    readonly body: string
  },
  JevContractError | RuneContractError
> =>
  Schema.decodeUnknownResult(
    RetainedDecisionRequestSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Retained model request is malformed', cause })),
    Result.flatMap(
      (request): ReturnType<typeof prepareRetainedDecisionRequest> =>
        request.model === runeModel ? prepareRuneRequest(request) : prepareJevRequest(request),
    ),
  )

export const decodeRetainedDecisionResponse = (
  request: RetainedDecisionRequest,
  input: unknown,
): Result.Result<RetainedDecisionResponse, JevContractError | RuneContractError> =>
  request.model === runeModel ? decodeRuneResponse(request, input) : decodeJevResponse(request, input)
