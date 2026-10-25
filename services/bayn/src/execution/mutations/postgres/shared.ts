import { Effect, Result } from 'effect'

export const fromDecision = <A, E>(evaluate: () => Result.Result<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => Effect.fromResult(evaluate()))
