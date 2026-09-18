import { expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1 } from '../hash'
import { reproduceStreamingSnapshot } from '../market-data/streaming/replay'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { candidateObservationLog, CandidateObservationStore, recordCandidateObservation } from './candidate-observation'

test('retains reproducible input evidence while keeping the routine candidate log small', () => {
  const { observation, snapshot } = candidateObservationFixture()
  const manifest = observation.payload.manifest
  if (manifest.schemaVersion !== 'bayn.streaming-market-snapshot.v1') throw new Error('expected streaming evidence')
  const replay = Result.getOrThrow(reproduceStreamingSnapshot(manifest, observation.payload.rows))
  expect(replay.manifest).toEqual(snapshot.manifest)
  expect(canonicalHashV1(observation.payload)).toBe(observation.contentHash)
  const log = candidateObservationLog(observation)
  expect(log.contentHash).toBe(observation.contentHash)
  expect(log.selectedSymbols).toEqual(observation.payload.decision.selectedSymbols)
  expect(log.candidates).toHaveLength(observation.payload.decision.signals.length)
  expect(JSON.stringify(log).length).toBeLessThan(4096)
  expect(JSON.stringify(log).length).toBeLessThan(JSON.stringify(observation.payload).length / 20)
})

test('fails the observation if its durable audit write fails', async () => {
  const { input } = candidateObservationFixture()
  const failure = operationalError({
    component: 'database',
    operation: 'candidate-observation',
    message: 'write failed',
  })
  const exit = await Effect.runPromiseExit(
    recordCandidateObservation(input).pipe(
      Effect.provideService(CandidateObservationStore, { record: () => Effect.fail(failure) }),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(JSON.stringify(exit)).toContain('write failed')
})
