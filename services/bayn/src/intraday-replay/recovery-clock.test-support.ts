import { Effect } from 'effect'
import type { WriterFenceService } from '../execution/writer-fence'
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

export const reconcileRecoveryFixture = <A, E, R, ClockError, ClockRequirements>(input: {
  readonly writerFence: WriterFenceService
  readonly advanceClock: Effect.Effect<void, ClockError, ClockRequirements>
  readonly reconcile: Effect.Effect<A, E, R>
}) =>
  input.writerFence.transaction(
    input.advanceClock.pipe(Effect.andThen(input.reconcile), Effect.andThen(input.advanceClock), Effect.asVoid),
  )
