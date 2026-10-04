import { Effect, Semaphore } from 'effect'
import type { AuthorityRestrictionStoreShape, ReconciliationPersistence } from '../db/execution-store'

const unused = () => Effect.die('Unexpected recovery containment persistence')

export const makeRecoveryContainmentStore = (
  restrictAuthority: AuthorityRestrictionStoreShape['restrictAuthority'],
): ReconciliationPersistence => ({
  events: { completeHistory: unused, ingest: unused, ingestPositions: unused },
  accounting: { account: unused, verifyCompleted: unused },
  valuation: { value: unused, hasAccountBaseline: unused },
  reconciliation: { bindings: unused, reconcile: unused },
  authorityRestriction: { restrictAuthority },
})

export const makeRecoveryClockFixture = <ClockError, ClockRequirements>(
  advanceClock: Effect.Effect<void, ClockError, ClockRequirements>,
) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1)
    const advance = Effect.uninterruptible(advanceClock)
    return {
      reconcile: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        permit.withPermit(advance.pipe(Effect.andThen(operation), Effect.andThen(advance), Effect.asVoid)),
      authority: <A, E, R>(operation: Effect.Effect<A, E, R>) => permit.withPermit(operation),
    }
  })
