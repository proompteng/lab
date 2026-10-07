import { Cause, Clock, Effect, Exit } from 'effect'

import type { CycleMutationReceipt, CycleStoreError, CycleStoreShape } from '../cycle/store'
import { isTerminalCycleState } from '../cycle'
import type { JevBatchStore } from '../jev/batch-evaluation'
import { operationTimeoutOrElse } from '../operation-timeout'

/** Best-effort evidence closure after a newly committed terminal transition, never a historical sweep. */
export const withTerminalJevEvidence = (
  store: CycleStoreShape,
  batches: typeof JevBatchStore.Service,
  operationTimeoutMs: number,
): CycleStoreShape => {
  const close = (receipt: CycleMutationReceipt) => {
    const { cycle } = receipt
    if (!receipt.changed || cycle.identity.strategyName !== 'jev' || !isTerminalCycleState(cycle.state))
      return Effect.void
    const cycleId = cycle.identity.cycleId
    const incomplete = (reason: string, batchId?: string) =>
      Effect.logWarning('Jev terminal evidence remains incomplete').pipe(
        Effect.annotateLogs({ cycleId, cleanupReason: reason, ...(batchId === undefined ? {} : { batchId }) }),
      )
    return Effect.gen(function* () {
      // A cycle can span authority generations. The cycle identity still fixes its account and session.
      const pending = yield* batches.pending(cycleId)
      for (const batchId of pending) {
        const saved = yield* batches.read(batchId)
        if (saved === null || saved.plan.cycleId !== cycleId) {
          yield* incomplete('BATCH_SCOPE_MISMATCH', batchId)
          continue
        }
        if (saved.result !== null) continue
        if ((yield* Clock.currentTimeMillis) < Date.parse(saved.plan.expiresAt)) {
          yield* incomplete('ORIGINAL_DEADLINE_PENDING', batchId)
          continue
        }
        if ((yield* batches.finish(batchId)).result === null) yield* incomplete('UNSEALED_RESULT', batchId)
      }
    }).pipe(
      // Reuse the configured operation budget and deadline clock; race cancellation joins the losing work.
      operationTimeoutOrElse({ duration: operationTimeoutMs, orElse: () => incomplete('TIMEOUT') }),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? incomplete('INTERRUPTED') : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : incomplete(Cause.hasDies(cause) ? 'DEFECT' : 'STORE_FAILURE'),
      ),
    )
  }
  const after = (mutation: Effect.Effect<CycleMutationReceipt, CycleStoreError>) => mutation.pipe(Effect.tap(close))
  return {
    ...store,
    activate: (...args) => after(store.activate(...args)),
    bindSnapshot: (...args) => after(store.bindSnapshot(...args)),
    bindDecision: (...args) => after(store.bindDecision(...args)),
    finish: (...args) => after(store.finish(...args)),
    block: (...args) => after(store.block(...args)),
  }
}
