import { Effect } from 'effect'

export const makeCapacitySqlProbes = (invalidated: () => boolean) => {
  const progress = { completed: 0, completedAfterInvalidation: 0 }
  return {
    progress,
    run: <A, E, R>(query: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const beganAfterInvalidation = invalidated()
        const rows = yield* query.pipe(Effect.timeout('1 second'))
        progress.completed++
        if (beganAfterInvalidation) progress.completedAfterInvalidation++
        return rows
      }),
  }
}
