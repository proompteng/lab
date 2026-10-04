import { describe, expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import { IsoDateSchema } from '../../contracts'
import { canonicalHashV1 } from '../../hash'
import { makeExecutionCalendarObservation } from '../../cycle/construction'
import { streamingFixture, fixtureStreamingReference } from '../../testing/streaming-market-fixture'
import {
  decideIntradayMomentum,
  verifyIntradayMomentumDecisionEnvelope,
} from '../../strategy/intraday-momentum/decision'
import { reproduceStreamingSnapshot } from './replay'
import { constructStreamingSnapshot } from './snapshot'
import { operationalError } from '../../errors'
import type { IntradayMarketDataService } from '../intraday/model'
import { loadIntradaySnapshot, executionMarketDataBinding } from '../../observe-composition/intraday-market-data'
import { reconstructBoundIntradaySnapshot } from '../../shadow-decision-contract'
import { decisionBuildError } from '../../observe-composition/decision-builder'
import { candidateObservationFixture } from '../../testing/candidate-observation-fixture'
import { retainAutonomousCyclePassObservation } from '../../cycle/runner/pass-decisions'
import { RetainedAutonomousCyclePassObservationSchema } from '../../cycle/runner/pass-observation'

describe('streaming strategy and recorded decision replay', () => {
  test('retains an unavailable benchmark feature identity through the durable waiting observation', () => {
    const { cut, query, protocol } = streamingFixture()
    const features = new Map(cut.projection.features)
    features.delete(protocol.benchmarkSymbol)
    const result = constructStreamingSnapshot({ ...cut, projection: { ...cut.projection, features } }, query)
    if (Result.isSuccess(result)) throw new Error('Missing benchmark feature must withhold the snapshot')
    const error = decisionBuildError(
      operationalError({
        component: 'market-data',
        operation: 'load',
        message: 'Streaming snapshot verification failed',
        cause: result.failure,
      }),
    )
    expect(error.failure).toBe('not-ready')
    const readiness = error.readiness
    if (readiness === undefined) throw new Error('Missing benchmark evidence must retain its readiness details')
    const expected = {
      reason: 'SNAPSHOT_UNAVAILABLE',
      symbol: protocol.benchmarkSymbol,
      eventAt: query.rangeEndAt,
      requiredFeature: {
        definitionId: protocol.streamingInput.requiredDefinitionId,
        definitionHash: protocol.streamingInput.requiredDefinitionHash,
        windowStartAt: query.rangeStartAt,
        windowEndAt: query.rangeEndAt,
      },
    }
    expect(readiness).toMatchObject(expected)
    const retained = retainAutonomousCyclePassObservation({
      outcome: 'SUCCEEDED',
      observedAt: query.observedAt,
      result: {
        outcome: 'RECOVERED',
        action: 'WAITING',
        observedAt: query.observedAt,
        cycle: candidateObservationFixture().cycle,
        readiness,
      },
    })
    expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(retained)).toMatchObject({
      recoveryAction: 'WAITING',
      readiness: expected,
    })
  })

  test('uses all seven decision symbols and reproduces the exact streaming decision', () => {
    const { snapshot, rows, protocol } = streamingFixture()
    const session = snapshot.manifest.calendar.sessions[0]
    if (session === undefined) throw new Error('missing fixture session')
    const calendar = Result.getOrThrow(
      makeExecutionCalendarObservation({
        ...session,
        schemaVersion: snapshot.manifest.calendar.schemaVersion,
        source: snapshot.manifest.calendar.source,
      }),
    )
    const boundSession = {
      sessionDate: Result.getOrThrow(Schema.decodeUnknownResult(IsoDateSchema)(session.date)),
      openAt: session.openAt,
      closeAt: session.closeAt,
      calendarHash: calendar.executionCalendarHash,
    }
    const streamed = Result.getOrThrow(decideIntradayMomentum({ snapshot, session: boundSession }, protocol))
    expect(streamed.selectedSymbols).toEqual(['AAPL'])
    expect(streamed.signals).toHaveLength(6)
    const live = Result.getOrThrow(decideIntradayMomentum({ snapshot, session: boundSession }, protocol))
    const replay = Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))
    expect(
      Result.isSuccess(
        verifyIntradayMomentumDecisionEnvelope(
          { snapshot: replay, session: boundSession },
          protocol,
          canonicalHashV1(live),
        ),
      ),
    ).toBe(true)
    const binding = Result.getOrThrow(executionMarketDataBinding(snapshot))
    expect(binding.schemaVersion).toBe('bayn.execution-market-data-binding.v3')
    if (binding.schemaVersion !== 'bayn.execution-market-data-binding.v3') throw new Error('wrong binding')
    expect(reconstructBoundIntradaySnapshot(binding, rows)?.manifest).toEqual(snapshot.manifest)
  })

  test('an unavailable canonical market adapter blocks observation', async () => {
    const { query } = streamingFixture()
    const market: IntradayMarketDataService = {
      check: Effect.void,
      loadSnapshot: () => operationalError({ component: 'market-data', operation: 'load', message: 'rebuilding' }),
      verifyReference: fixtureStreamingReference,
    }
    expect(Result.isFailure(await Effect.runPromise(Effect.result(loadIntradaySnapshot(market, query))))).toBe(true)
  })

  test('excludes an unavailable candidate but does not emit a valid observation when every candidate is unavailable', () => {
    const { cut, query, protocol } = streamingFixture()
    const features = new Map(cut.projection.features)
    features.delete('AAPL')
    const partial = Result.getOrThrow(
      constructStreamingSnapshot({ ...cut, projection: { ...cut.projection, features } }, query),
    )
    expect(partial.manifest.candidateExclusions).toEqual([
      expect.objectContaining({ symbol: 'AAPL', reason: 'not-ready' }),
    ])
    for (const symbol of protocol.candidateSymbols) features.delete(symbol)
    expect(
      Result.isFailure(constructStreamingSnapshot({ ...cut, projection: { ...cut.projection, features } }, query)),
    ).toBe(true)
    features.delete(protocol.benchmarkSymbol)
    expect(
      Result.isFailure(constructStreamingSnapshot({ ...cut, projection: { ...cut.projection, features } }, query)),
    ).toBe(true)
  })
})
