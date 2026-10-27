import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevContractError, JevFailure } from './contract'
import { decodeEntryHandoff } from './entry-inference-evidence'
import { type EntryHandoff } from './entry-inference'
import { decodeJevEvaluationRequest, decodeJevEvaluationReceipt, JevOutcome } from './evidence'
import { decodeJevResolution } from './resolution'
import { decodeStagedCheckpoint, type StagedCheckpoint } from './staged-checkpoint'
import type { DecisionsUsageSchema } from './decisions'

const invalid = (message: string) => Result.fail(new JevContractError({ message }))
export const verifyStagedCheckpointHandoff = (checkpoint: StagedCheckpoint, handoff: EntryHandoff) =>
  Result.gen(function* () {
    for (const row of [...checkpoint.claims, ...checkpoint.terminals, ...checkpoint.skips]) {
      const at = 'claimedAt' in row ? row.claimedAt : row.recordedAt
      if (at > handoff.recordedAt) return yield* invalid('Staged handoff precedes committed provider evidence')
    }
    const chart = checkpoint.terminals.find((row) => row.stage === 'CHART')
    const disposition = handoff.disposition
    if (disposition.status === 'SOURCE_INFEASIBLE') {
      if (checkpoint.claims.length !== 0) return yield* invalid('Source-infeasible handoff omits a visual dispatch')
    } else {
      if (chart === undefined) return yield* invalid('Staged handoff has no committed chart terminal')
      const expected =
        disposition.status === 'VISUAL_FAILED'
          ? { status: 'FAILED', failure: disposition.failure }
          : { status: 'RECEIVED', inference: disposition.visual }
      if ((yield* canonicalHashV1Result(expected)) !== (yield* canonicalHashV1Result(chart.outcome)))
        return yield* invalid('Staged handoff changes the committed chart outcome')
    }
    const base = handoff.baseStart
    if (base.status === 'NOT_REQUESTED') {
      const skip = checkpoint.skips.find((row) => row.stage === 'BASE_START')
      if (skip === undefined || (yield* canonicalHashV1Result(skip)) !== (yield* canonicalHashV1Result(base.skip)))
        return yield* invalid('Staged handoff changes its committed base-start skip')
    } else {
      const terminal = checkpoint.terminals.find((row) => row.stage === 'BASE_START')
      if (
        terminal === undefined ||
        (yield* canonicalHashV1Result(terminal.outcome)) !== (yield* canonicalHashV1Result(base))
      )
        return yield* invalid('Staged handoff changes its committed base-start outcome')
    }
    return handoff
  })

export interface VisualCostStage {
  readonly stage: 'CHART' | 'BASE_START'
  readonly claimHash: string | null
  readonly terminalHash: string | null
  readonly skipHash: string | null
  readonly startedAt: string | undefined
  readonly outcome: 'UNKNOWN' | 'NOT_DISPATCHED' | 'RECEIVED' | 'REJECTED'
  readonly usage: typeof DecisionsUsageSchema.Type | null
  readonly handoffHash: string | null
  readonly receiptHash: string | null
  readonly resolutionHash: string | null
}

// This is the new-version evidence boundary, not a second financial report reader.
// Full source validation happens once before the existing typed-facts pipeline.
export const readStagedInferenceCostEvidence = (row: {
  readonly request: unknown
  readonly receipt: unknown
  readonly resolution: unknown
  readonly handoff: unknown
  readonly stagedCheckpoint: unknown
}) =>
  Result.gen(function* () {
    const request = yield* decodeJevEvaluationRequest(row.request)
    const checkpoint = yield* decodeStagedCheckpoint(row.request, row.stagedCheckpoint)
    const receipt = row.receipt === null ? null : yield* decodeJevEvaluationReceipt(request, row.receipt)
    const resolution = row.resolution === null ? null : yield* decodeJevResolution(request, receipt, row.resolution)
    const handoff =
      row.handoff === null
        ? null
        : yield* decodeEntryHandoff(
            {
              requestId: request.requestId,
              input: request.request,
              observedAt: request.observedAt,
              expiresAt: request.expiresAt,
            },
            row.handoff,
          )
    if (handoff !== null) yield* verifyStagedCheckpointHandoff(checkpoint, handoff)
    if (
      receipt?.outcome.status === JevOutcome.Completed &&
      (handoff === null || receipt.outcome.completion.handoff.handoffHash !== handoff.handoffHash)
    )
      return yield* invalid('Staged completion differs from its committed handoff')
    const expiredUndispatched =
      receipt?.outcome.status === JevOutcome.Failed && receipt.outcome.failure === JevFailure.NotDispatched
    if (expiredUndispatched && checkpoint.claims.length !== 0)
      return yield* invalid('Undispatched receipt omits a committed staged provider claim')
    const visualStages = (['CHART', 'BASE_START'] as const).map((stage): VisualCostStage => {
      const claim = checkpoint.claims.find((value) => value.stage === stage)
      const terminal = checkpoint.terminals.find((value) => value.stage === stage)
      const skip = stage === 'BASE_START' ? checkpoint.skips[0] : undefined
      const outcome = terminal?.outcome
      const usage = outcome?.status === 'RECEIVED' ? outcome.inference.response.usage : (outcome?.failure.usage ?? null)
      const zero = skip !== undefined || expiredUndispatched || handoff?.disposition.status === 'SOURCE_INFEASIBLE'
      return {
        stage,
        claimHash: claim?.claimHash ?? null,
        terminalHash: terminal?.terminalHash ?? null,
        skipHash: skip?.skipHash ?? null,
        startedAt: outcome?.status === 'RECEIVED' ? outcome.inference.startedAt : claim?.claimedAt,
        outcome: zero
          ? 'NOT_DISPATCHED'
          : usage === null
            ? 'UNKNOWN'
            : outcome?.status === 'RECEIVED'
              ? 'RECEIVED'
              : 'REJECTED',
        usage,
        handoffHash: claim !== undefined || skip !== undefined ? null : (handoff?.handoffHash ?? null),
        receiptHash: expiredUndispatched ? receipt.receiptHash : null,
        resolutionHash: expiredUndispatched ? (resolution?.resolutionHash ?? null) : null,
      }
    })
    return { request, receipt, resolution, handoff, checkpoint, visualStages }
  })
