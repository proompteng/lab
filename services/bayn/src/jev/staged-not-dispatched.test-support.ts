import { Result, Schema } from 'effect'

import type { InferenceExpenseSource } from '../inference-expense'
import { IsoDateSchema } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { entryEvaluationRequestFixture, stagedCheckpointFixture } from './entry-inference.test-support'
import { makeStagedTerminalReceipt } from './staged-checkpoint'

export const undispatchedVisualFixture = (reason: 'ORIGINAL_EXPIRY' | 'ADMISSION_EXPIRY' = 'ORIGINAL_EXPIRY') => {
  const request = entryEvaluationRequestFixture()
  const claim = stagedCheckpointFixture(request).claims[0]
  if (claim === undefined) throw new Error('Expected fixture chart claim')
  const deadlineAt =
    reason === 'ORIGINAL_EXPIRY' ? request.expiresAt : utcInstantFromEpochMillis(Date.parse(request.expiresAt) - 1000)
  const at = utcInstantFromEpochMillis(Date.parse(deadlineAt) + 223)
  const terminal = Result.getOrThrow(
    makeStagedTerminalReceipt({
      schemaVersion: 'bayn.staged-terminal-receipt.v2',
      stage: 'CHART',
      requestId: request.requestId,
      claimHash: claim.claimHash,
      recordedAt: at,
      outcome: { status: 'NOT_DISPATCHED', reason, deadlineAt, checkedAt: at },
    }),
  )
  const source = {
    accountId: 'undispatched-account',
    sessionDate: Result.getOrThrow(Schema.decodeUnknownResult(IsoDateSchema)(request.observedAt.slice(0, 10))),
    asOf: at,
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt: null,
    resolution: null,
    handoff: null,
    stagedCheckpoint: { claims: [claim], terminals: [terminal], skips: [] },
  } satisfies InferenceExpenseSource
  return { request, claim, terminal, source }
}
