import { Effect } from 'effect'
import type { EntryHandoff } from './entry-inference'
import { ProposalRejection } from './entry-proposals'

/** A diagnostic projection, never provider material or financial evidence. */
export const entryHandoffDiagnostic = (cycleId: string, handoff: EntryHandoff) => {
  const disposition = handoff.disposition
  const evaluation =
    disposition.status === 'READY' || disposition.status === 'NO_FUNDED_PROPOSALS' ? disposition.evaluation : null
  return {
    event: 'bayn.entry-handoff-diagnostic.v1',
    cycleId,
    requestId: handoff.requestId,
    handoffHash: handoff.handoffHash,
    disposition: disposition.status,
    proposalCount: evaluation?.proposals.length ?? 0,
    // Enumerate the closed vocabulary instead of copying unbounded provider fields.
    rejectionCounts: Object.values(ProposalRejection).flatMap((reason) => {
      const count = evaluation?.rejections.filter((rejection) => rejection.reason === reason).length ?? 0
      return count === 0 ? [] : [{ reason, count }]
    }),
  }
}

export const logCommittedEntryHandoff = (cycleId: string, handoff: EntryHandoff) =>
  Effect.sync(() => entryHandoffDiagnostic(cycleId, handoff)).pipe(
    Effect.flatMap(Effect.logInfo),
    // Diagnostics must not turn an acknowledged journal commit into a failed dispatch.
    Effect.catchDefect(() => Effect.void),
  )
