import { Result } from 'effect'

import { canonicalHashV1 } from './hash'
import { JevFailure } from './jev/contract'
import { JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from './jev/evidence'
import { JevResolutionStatus, makeJevResolution } from './jev/resolution'
import { evaluationRequestFixture, responseFixture } from './jev/test-support'
import type { InferenceExpenseSource } from './inference-expense'

export const expenseRateFixture = {
  schemaVersion: 'bayn.inference-rate-card.v1',
  rates: [
    {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      currency: 'USD',
      source: 'synthetic fixture',
      effectiveFrom: '1970-01-01T00:00:00.000Z',
      effectiveUntil: '1970-01-02T00:00:00.000Z',
      inputMicrosPerMillionTokens: '42000',
      outputMicrosPerMillionTokens: '0',
    },
  ],
} as const

export const expenseSourceFixture = (
  options: {
    key?: string
    accountId?: string
    inputTokens?: number
    missing?: boolean
    rejected?: boolean
    abandoned?: boolean
  } = {},
): InferenceExpenseSource => {
  const { requestId: _id, ...material } = evaluationRequestFixture()
  const request = Result.getOrThrow(makeJevEvaluationRequest({ ...material, cycleId: (options.key ?? 'a').repeat(64) }))
  const response = { ...responseFixture(), usage: { input_tokens: options.inputTokens ?? 1, output_tokens: 80 } }
  const receipt = options.missing
    ? null
    : Result.getOrThrow(
        makeJevEvaluationReceipt(request, {
          schemaVersion: 'bayn.jev-evaluation-receipt.v1',
          requestId: request.requestId,
          startedAt: request.observedAt,
          completedAt: request.observedAt,
          outcome: options.rejected
            ? {
                status: JevOutcome.Failed,
                failure: JevFailure.Response,
                httpStatus: 429,
                responseHash: canonicalHashV1(response),
                rejectedResponse: response,
              }
            : {
                status: JevOutcome.Received,
                inference: {
                  requestHash: request.requestHash,
                  responseHash: canonicalHashV1(response),
                  startedAt: request.observedAt,
                  completedAt: request.observedAt,
                  response,
                },
              },
        }),
      )
  const resolution = Result.getOrThrow(
    makeJevResolution(
      request,
      receipt,
      receipt === null || options.abandoned
        ? {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Abandoned,
            abandonedAt: request.expiresAt,
          }
        : {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          },
    ),
  )
  return {
    accountId: options.accountId ?? 'fixture-account',
    sessionDate: '1970-01-01',
    asOf: new Date(Date.parse(request.expiresAt) + 1000).toISOString(),
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt,
    resolution,
  }
}
