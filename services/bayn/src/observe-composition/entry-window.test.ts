import { expect, test } from 'bun:test'
import { Effect, Option } from 'effect'

import { operationalError } from '../errors'
import { JevPurpose } from '../jev/portfolio'
import { CandidateObservationStore } from './candidate-observation'
import { nextJevEntryWindowDueAt } from './entry-window'

test('uses durable ENTRY consumption and the current protocol decision delay', async () => {
  const decisionDelaySeconds = 2
  const reads: { readonly cycleId: string; readonly purpose: JevPurpose }[] = []
  const due = await Effect.runPromise(
    nextJevEntryWindowDueAt('prior-terminal-cycle', { decisionDelaySeconds }).pipe(
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.die('successor discovery must not record a new observation'),
        latestJevWindowEnd: (input) =>
          Effect.sync(() => {
            reads.push(input)
            return Option.some('2026-11-19T20:44:00.000Z')
          }),
      }),
    ),
  )
  expect(reads).toEqual([{ cycleId: 'prior-terminal-cycle', purpose: JevPurpose.Entry }])
  expect(Option.getOrThrow(due)).toBe('2026-11-19T20:45:02.000Z')
})

test('does not invent a source boundary without a retained entry observation', async () => {
  const due = await Effect.runPromise(
    nextJevEntryWindowDueAt('unconsumed-cycle', { decisionDelaySeconds: 2 }).pipe(
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.die('unexpected observation write'),
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
    ),
  )
  expect(Option.isNone(due)).toBe(true)
})

test('a failed consumption read remains a failure rather than an absent observation', async () => {
  const failure = operationalError({
    component: 'database',
    operation: 'candidate-observation',
    message: 'read unavailable',
  })
  const result = await Effect.runPromise(
    nextJevEntryWindowDueAt('prior-terminal-cycle', { decisionDelaySeconds: 2 }).pipe(
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.die('unexpected observation write'),
        latestJevWindowEnd: () => Effect.fail(failure),
      }),
      Effect.flip,
    ),
  )
  expect(result).toBe(failure)
})
