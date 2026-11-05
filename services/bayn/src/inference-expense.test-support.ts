import { Result } from 'effect'

import { canonicalHashV1Result } from './hash'
import { decodeInferenceCostEvidence, makeInferenceCostReport } from './inference-costs'
import { JevFailure, type JevRequest } from './jev/contract'
import { decodeHistoricalJevCostEvidence } from './jev/historical-inference-cost-evidence'
import { JevResolutionStatus, makeJevResolution } from './jev/resolution'
import { requestFixture, responseFixture } from './jev/test-support'
import { verifyInferenceExpenseCoverage, type InferenceExpenseSource } from './inference-expense'

export const costReportFromEvidence = (evidence: unknown, rates: unknown) =>
  decodeInferenceCostEvidence(evidence).pipe(Result.flatMap((decoded) => makeInferenceCostReport(decoded, rates)))

export const expenseCoverageFromEvidence = (
  evidence: unknown,
  accountId: string,
  frozen: Parameters<typeof verifyInferenceExpenseCoverage>[2],
) =>
  decodeInferenceCostEvidence(evidence).pipe(
    Result.flatMap((decoded) => verifyInferenceExpenseCoverage(decoded, accountId, frozen)),
  )

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
    key?: string | undefined
    authorityGenerationHash?: string
    accountId?: string
    observedAt?: string
    inputTokens?: number
    missing?: boolean | undefined
    rejected?: boolean | undefined
    abandoned?: boolean
    notDispatched?: boolean | undefined
    state?: JevRequest['state']
  } = {},
) => {
  const inferenceRequest = { ...requestFixture, state: options.state ?? requestFixture.state }
  const material = {
    schemaVersion: 'bayn.jev-evaluation-request.v1',
    cycleId: (options.key ?? 'a').repeat(64),
    authorityGenerationHash: options.authorityGenerationHash ?? 'b'.repeat(64),
    snapshotId: 'c'.repeat(64),
    symbol: 'AAPL',
    observedAt: options.observedAt ?? '1970-01-01T00:00:00.000Z',
    expiresAt: new Date(Date.parse(options.observedAt ?? '1970-01-01T00:00:00.000Z') + 5000).toISOString(),
    request: inferenceRequest,
    requestHash: Result.getOrThrow(canonicalHashV1Result(inferenceRequest)),
  }
  const request = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
  const response = { ...responseFixture(), usage: { input_tokens: options.inputTokens ?? 1, output_tokens: 80 } }
  const receiptMaterial = {
    schemaVersion: 'bayn.jev-evaluation-receipt.v1',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: options.notDispatched ? request.expiresAt : request.observedAt,
    outcome: options.notDispatched
      ? {
          status: 'FAILED',
          failure: JevFailure.NotDispatched,
          httpStatus: null,
          responseHash: null,
          rejectedResponse: null,
        }
      : options.rejected
        ? {
            status: 'FAILED',
            failure: JevFailure.Response,
            httpStatus: 429,
            responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
            rejectedResponse: response,
          }
        : {
            status: 'RECEIVED',
            inference: {
              requestHash: request.requestHash,
              responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
              startedAt: request.observedAt,
              completedAt: request.observedAt,
              response,
            },
          },
  }
  const rawReceipt = options.missing
    ? null
    : { ...receiptMaterial, receiptHash: Result.getOrThrow(canonicalHashV1Result(receiptMaterial)) }
  const { request: verifiedRequest, receipt } = Result.getOrThrow(
    decodeHistoricalJevCostEvidence(request, rawReceipt, null),
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
    request: verifiedRequest,
    receipt,
    resolution,
    handoff: null,
  } satisfies InferenceExpenseSource
}
