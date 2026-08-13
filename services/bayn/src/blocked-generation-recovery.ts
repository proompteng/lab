import { Effect, Result } from 'effect'

import type { AuthorityGenerationStoreShape } from './db/execution-store'
import { BlockedCycleIntentStoreError, type BlockedCycleIntentStoreShape } from './execution/intents'
import { Authority, KillState } from './execution/contracts'
import type { WriterFenceService } from './execution/writer-fence'
import { OperationalError } from './errors'
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import { currentUtcInstant } from './time'

const observeSuccessorSchemaVersion = 'bayn.paper-observe-successor-generation.v1' as const

/**
 * Derives the immutable OBSERVE successor for one terminal execution generation. The configured generation is only a
 * bootstrap key, not a reusable history key; the terminal execution hash makes retries deterministic and independent of
 * which reviewed build performs recovery.
 */
export const executionObserveSuccessorGenerationHash = (input: {
  readonly previousExecutionGenerationHash: string
}): Result.Result<string, CanonicalHashFailure> =>
  canonicalHashV1Result({
    schemaVersion: observeSuccessorSchemaVersion,
    // This property name is part of the immutable v1 hash material. Keep it stable while the runtime API remains
    // account-neutral; changing it would orphan successors already persisted by earlier releases.
    previousPaperGenerationHash: input.previousExecutionGenerationHash,
  })

export type TerminalGenerationRolloverReceipt =
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

export interface TerminalGenerationRecoveryInput<R> {
  readonly accountId: string
  readonly blockedIntents: BlockedCycleIntentStoreShape
  readonly authorityStore: AuthorityGenerationStoreShape
  readonly writerFence: WriterFenceService
  /** Must persist and validate a fresh exact, flat reconciliation after intent settlement. */
  readonly reconcileAfterSettlement: Effect.Effect<void, OperationalError, R>
}

const recoveryError = (message: string, cause?: unknown): OperationalError =>
  new OperationalError({
    component: 'strategy',
    operation: 'terminal-generation-recovery',
    message,
    retryable: false,
    cause: cause === undefined ? { _tag: 'TerminalGenerationRecoveryRejected' } : cause,
  })

const settlementNeedsMutationRecovery = (error: OperationalError): boolean =>
  error.operation === 'terminal-generation-recovery' &&
  error.cause instanceof BlockedCycleIntentStoreError &&
  error.cause.failure === 'invariant'

/**
 * A restricted execution generation may still own a nonterminal mutation when the process restarts. Advance the existing
 * recovery-first driver before every settlement attempt; only the precise nonterminal-intent invariant waits and
 * retries. Query, decode, reconciliation, and authority failures remain fatal.
 */
export const recoverRestrictedGenerationBeforeRollover = <A, E, R>(input: {
  readonly advance: Effect.Effect<A, E, R>
  readonly wait: (advance: A) => Effect.Effect<void, never, R>
  readonly settle: Effect.Effect<TerminalGenerationRolloverReceipt, OperationalError, R>
}): Effect.Effect<TerminalGenerationRolloverReceipt, E | OperationalError, R> => {
  const recover = (): Effect.Effect<TerminalGenerationRolloverReceipt, E | OperationalError, R> =>
    input.advance.pipe(
      Effect.flatMap((advanced) =>
        input.settle.pipe(
          Effect.catchIf(settlementNeedsMutationRecovery, () => input.wait(advanced).pipe(Effect.andThen(recover()))),
          Effect.flatMap((receipt) =>
            receipt._tag === 'RolledOver'
              ? Effect.succeed(receipt)
              : Effect.fail(recoveryError('restricted generation recovery found no terminal generation to roll over')),
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
export const recoverTerminalGenerationToObserve = <R>(
  input: TerminalGenerationRecoveryInput<R>,
): Effect.Effect<TerminalGenerationRolloverReceipt, OperationalError, R> =>
  Effect.gen(function* () {
    const observedAt = yield* currentUtcInstant
    const settlement = yield* input.writerFence
      .transaction(input.blockedIntents.settleCurrentTerminalGeneration({ accountId: input.accountId, observedAt }))
      .pipe(Effect.mapError((cause) => recoveryError('terminal generation intent settlement failed', cause)))
    if (settlement._tag === 'NoTerminalGeneration') return { _tag: 'NotRequired' }

    yield* Effect.logWarning('Bayn settled a terminal execution generation before authority rollover').pipe(
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
    const successorGenerationHash = yield* Effect.fromResult(
      executionObserveSuccessorGenerationHash({
        previousExecutionGenerationHash: settlement.authorityGenerationHash,
      }),
    ).pipe(Effect.mapError((cause) => recoveryError('terminal generation OBSERVE successor hashing failed', cause)))
    const authority = yield* input.authorityStore
      .ensureAuthorityGeneration({ generationHash: successorGenerationHash, maximum: Authority.Observe })
      .pipe(Effect.mapError((cause) => recoveryError('terminal generation OBSERVE rollover failed', cause)))
    if (
      authority.generationHash !== successorGenerationHash ||
      authority.maximum !== Authority.Observe ||
      authority.effective !== Authority.Observe ||
      authority.kill !== KillState.Clear
    ) {
      return yield* recoveryError('terminal generation rollover did not return clear OBSERVE authority')
    }

    yield* Effect.logInfo('Bayn completed terminal generation rollover to clear OBSERVE').pipe(
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
