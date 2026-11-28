import { Result, Schema } from 'effect'
import { IsoDateSchema } from '../schemas'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import type { EntryInferenceCompletion } from '../jev/entry-inference'
import {
  entryCompletionFixture,
  entryEvaluationRequestFixture,
  stagedCheckpointFixture,
} from '../jev/entry-inference.test-support'
import { JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import type { InferenceExpenseSource } from '../inference-expense'

const stagedRequest = entryEvaluationRequestFixture()
const stagedCompletion = entryCompletionFixture(stagedRequest)

export const stagedExpenseSourceFixture = (
  completed: EntryInferenceCompletion | null = stagedCompletion,
  handoff = completed?.handoff ?? stagedCompletion.handoff,
  abandoned = completed === null,
  request = stagedRequest,
): InferenceExpenseSource => {
  const receipt =
    completed === null
      ? null
      : Result.getOrThrow(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: request.requestId,
            startedAt: request.observedAt,
            completedAt: completed.completedAt,
            outcome: { status: JevOutcome.Completed, completion: completed },
          }),
        )
  const resolution = Result.getOrThrow(
    makeJevResolution(
      request,
      receipt,
      abandoned
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
            receiptHash: receipt?.receiptHash,
          },
    ),
  )
  return {
    accountId: 'stage-cost-fixture',
    sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(request.observedAt.slice(0, 10)),
    asOf: new Date(Date.parse(request.expiresAt) + 60000).toISOString(),
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt,
    resolution,
    handoff,
    stagedCheckpoint: stagedCheckpointFixture(request),
  }
}
