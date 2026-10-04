import { Effect } from 'effect'
import type { WriterFenceService } from '../execution/writer-fence'

export const reconcileRecoveryFixture = <A, E, R, ClockError, ClockRequirements>(input: {
  readonly writerFence: WriterFenceService
  readonly advanceClock: Effect.Effect<void, ClockError, ClockRequirements>
  readonly reconcile: Effect.Effect<A, E, R>
}) => input.advanceClock.pipe(Effect.andThen(input.reconcile), Effect.andThen(input.advanceClock), Effect.asVoid)
