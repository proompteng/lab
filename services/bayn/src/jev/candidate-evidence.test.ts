import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { streamingFixture } from '../testing/streaming-market-fixture'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { defaultJevProtocolDocument } from './protocol'
import { makeJevEntryQuery } from './observation-query'
import { jevObservationForSnapshot } from './native.test-support'
import { makeJevTradingSignalBatch, makeJevTradingSignalRequest } from './trading-signals'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from './batch'

test('a fresh equity candidate does not require an unused SPY feature', () => {
  const fixture = streamingFixture()
  const query = makeJevEntryQuery({
    protocol: defaultJevProtocolDocument,
    calendar: fixture.query.calendar,
    sessionDate: fixture.query.sessionDate,
    observedAtMs: Date.parse(fixture.query.observedAt),
    candidates: ['AAPL'],
  })
  const features = new Map(fixture.cut.projection.features)
  features.delete('SPY')
  const cut = { ...fixture.cut, projection: { ...fixture.cut.projection, features } }
  const snapshot = constructStreamingSnapshot(cut, query)
  expect(snapshot).toMatchObject({ _tag: 'Success' })
  expect(Result.getOrThrow(snapshot).manifest.symbols).toEqual(['AAPL'])
  const observation = Result.getOrThrow(jevObservationForSnapshot(Result.getOrThrow(snapshot))).payload
  const request = Result.getOrThrow(makeJevTradingSignalRequest(observation, 'AAPL'))
  const reference = Result.getOrThrow(jevObservationForSnapshot(fixture.snapshot)).payload
  expect(request.body).toBe(Result.getOrThrow(makeJevTradingSignalRequest(reference, 'AAPL')).body)
  expect(request.input.numericalState).not.toHaveProperty('benchmark')
  expect(request.input.numericalState).not.toHaveProperty('relativeSignals')
  const plan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observation.observedAt) + observation.protocol.inferenceValidityMs).toISOString(),
      planVersion: JevBatchPlanVersion.V8,
    }),
  )
  expect(plan.candidates).toMatchObject([{ symbol: 'AAPL', status: JevCandidatePlanStatus.Requested }])
  features.delete('AAPL')
  expect(constructStreamingSnapshot(cut, query)).toMatchObject({ _tag: 'Failure' })
  const independent = Result.getOrThrow(
    constructStreamingSnapshot(cut, {
      ...query,
      symbols: ['AAPL', 'AMZN'],
      candidateSymbols: ['AAPL', 'AMZN'],
    }),
  )
  const independentObservation = Result.getOrThrow(jevObservationForSnapshot(independent)).payload
  const independentPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: independentObservation,
      expiresAt: plan.expiresAt,
      planVersion: JevBatchPlanVersion.V8,
    }),
  )
  expect(independentPlan.candidates).toMatchObject([
    { symbol: 'AAPL', status: JevCandidatePlanStatus.Excluded, reason: 'not-ready' },
    { symbol: 'AMZN', status: JevCandidatePlanStatus.Requested },
  ])
})
