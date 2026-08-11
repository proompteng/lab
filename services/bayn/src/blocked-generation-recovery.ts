import { Effect } from 'effect'

import type { AuthorityGenerationStoreShape } from './db/execution-store'
import { BlockedCycleIntentStoreError, type BlockedCycleIntentStoreShape } from './execution/intents'
import { Authority, KillState } from './execution/contracts'
import type { WriterFenceService } from './execution/writer-fence'
import { OperationalError } from './errors'
import { currentUtcInstant } from './time'

export type BlockedGenerationRolloverReceipt =
  | { readonly _tag: 'NotRequired' }
  | {
      readonly _tag: 'RolledOver'
      readonly previousGenerationHash: string
      readonly generationHash: string
      readonly blockedCycleCount: number
      readonly blockedIntentCount: number
      readonly expiredIntentCount: number
      readonly terminalIntentCount: number
    }

export interface BlockedGenerationRecoveryInput<R> {
  readonly accountId: string
  readonly observeGenerationHash: string
  readonly blockedIntents: BlockedCycleIntentStoreShape
  readonly authorityStore: AuthorityGenerationStoreShape
  readonly writerFence: WriterFenceService
  /** Must persist and validate a fresh exact, flat reconciliation after intent settlement. */
  readonly reconcileAfterSettlement: Effect.Effect<void, OperationalError, R>
}

const recoveryError = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({
    component: 'strategy',
    operation: 'blocked-generation-recovery',
    message,
    retryable: false,
    cause: cause === undefined ? { _tag: 'BlockedGenerationRecoveryRejected' } : cause,
  })

const settlementNeedsMutationRecovery = (error: OperationalError): boolean =>
  error.operation === 'blocked-generation-recovery' &&
  error.cause instanceof BlockedCycleIntentStoreError &&
  error.cause.failure === 'invariant'

/**
 * A restricted PAPER generation may still own a nonterminal mutation when the process restarts. Advance the existing
 * recovery-first driver before every settlement attempt; only the precise nonterminal-intent invariant waits and
 * retries. Query, decode, reconciliation, and authority failures remain fatal.
 */
export const recoverRestrictedGenerationBeforeRollover = <A, E, R>(input: {
  readonly advance: Effect.Effect<A, E, R>
  readonly wait: (advance: A) => Effect.Effect<void, never, R>
  readonly settle: Effect.Effect<BlockedGenerationRolloverReceipt, OperationalError, R>
}): Effect.Effect<BlockedGenerationRolloverReceipt, E | OperationalError, R> => {
  const recover = (): Effect.Effect<BlockedGenerationRolloverReceipt, E | OperationalError, R> =>
    input.advance.pipe(
      Effect.flatMap((advanced) =>
        input.settle.pipe(
          Effect.catchIf(settlementNeedsMutationRecovery, () => input.wait(advanced).pipe(Effect.andThen(recover()))),
          Effect.flatMap((receipt) =>
            receipt._tag === 'RolledOver'
              ? Effect.succeed(receipt)
              : Effect.fail(recoveryError('restricted generation recovery found no blocked generation to roll over')),
          ),
        ),
      ),
    )
  return Effect.suspend(recover)
}

/**
 * Settles the terminal generation first, then requires later exact reconciliation before clearing the kill in a new
 * OBSERVE generation. The transaction boundary intentionally excludes reconciliation and authority rollover.
 */
export const recoverBlockedGenerationToObserve = <R>(
  input: BlockedGenerationRecoveryInput<R>,
): Effect.Effect<BlockedGenerationRolloverReceipt, OperationalError, R> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const settlement = yield* input.writerFence
      .transaction(input.blockedIntents.settleCurrentBlockedGeneration({ accountId: input.accountId, observedAt }))
      .pipe(Effect.mapError((cause) => recoveryError('blocked generation intent settlement failed', cause)))
    if (settlement._tag === 'NoBlockedGeneration') return { _tag: 'NotRequired' }

    yield* Effect.logWarning('Bayn settled a terminal blocked generation before authority rollover').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        previousGenerationHash: settlement.authorityGenerationHash,
        blockedCycleCount: settlement.blockedCycleCount,
        blockedIntentCount: settlement.blockedIntentCount,
        expiredIntentCount: settlement.expiredIntentCount,
        terminalIntentCount: settlement.terminalIntentCount,
      }),
    )

    yield* input.reconcileAfterSettlement
    const authority = yield* input.authorityStore
      .ensureAuthorityGeneration({ generationHash: input.observeGenerationHash, maximum: Authority.Observe })
      .pipe(Effect.mapError((cause) => recoveryError('blocked generation OBSERVE rollover failed', cause)))
    if (
      authority.generationHash !== input.observeGenerationHash ||
      authority.maximum !== Authority.Observe ||
      authority.effective !== Authority.Observe ||
      authority.kill !== KillState.Clear
    ) {
      return yield* recoveryError('blocked generation rollover did not return clear OBSERVE authority')
    }

    yield* Effect.logInfo('Bayn completed blocked generation rollover to clear OBSERVE').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        previousGenerationHash: settlement.authorityGenerationHash,
        generationHash: authority.generationHash,
        authorityVersion: authority.version,
        authorityEffective: authority.effective,
        authorityKill: authority.kill,
      }),
    )
    return {
      _tag: 'RolledOver',
      previousGenerationHash: settlement.authorityGenerationHash,
      generationHash: authority.generationHash,
      blockedCycleCount: settlement.blockedCycleCount,
      blockedIntentCount: settlement.blockedIntentCount,
      expiredIntentCount: settlement.expiredIntentCount,
      terminalIntentCount: settlement.terminalIntentCount,
    }
  })
