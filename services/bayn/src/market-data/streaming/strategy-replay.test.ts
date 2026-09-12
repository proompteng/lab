import { compareStreamingShadowSnapshots } from '../../observe-composition/streaming-shadow'
import { describe, expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import { IsoDateSchema } from '../../contracts'
import { canonicalHashV1 } from '../../hash'
import { makeExecutionCalendarObservation } from '../../cycle/construction'
import { streamingFixture } from '../../testing/streaming-market-fixture'
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

describe('streaming strategy and recorded decision replay', () => {
  test('uses all seven decision symbols, matches archive signals, and reproduces the exact streaming decision', () => {
    const { snapshot, rows, archive, protocol } = streamingFixture()
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
    const historical = Result.getOrThrow(decideIntradayMomentum({ snapshot: archive, session: boundSession }, protocol))
    expect(compareStreamingShadowSnapshots(archive, snapshot).outcome).toBe('decision-match')
    expect(streamed.signals).toEqual(historical.signals)
    expect(streamed.benchmark).toEqual(historical.benchmark)
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

  test('only explicit shadow mode continues archive execution when streaming is unavailable', async () => {
    const { snapshot, archive, query } = streamingFixture()
    let archiveLoads = 0
    const market: IntradayMarketDataService = {
      check: Effect.void,
      captureVersion: () => Effect.succeed(archive.manifest.archiveWatermarks),
      loadSnapshot: () =>
        Effect.sync(() => {
          archiveLoads++
          return archive
        }),
      verifyArchiveSnapshot: () => Effect.succeed(archive),
      streaming: {
        shadowOnly: true,
        loadSnapshot: () => operationalError({ component: 'market-data', operation: 'load', message: 'rebuilding' }),
        verifyReference: () => Effect.die('unused'),
      },
    }
    expect(await Effect.runPromise(loadIntradaySnapshot(market, query))).toBe(archive)
    expect(archiveLoads).toBe(1)
    const executing: IntradayMarketDataService = {
      ...market,
      streaming: {
        shadowOnly: false,
        loadSnapshot: () => operationalError({ component: 'market-data', operation: 'load', message: 'rebuilding' }),
        verifyReference: () => Effect.die('unused'),
      },
    }
    expect(Result.isFailure(await Effect.runPromise(Effect.result(loadIntradaySnapshot(executing, query))))).toBe(true)
    expect(archiveLoads).toBe(1)
    expect(
      compareStreamingShadowSnapshots(archive, {
        ...snapshot,
        manifest: { ...snapshot.manifest, barsContentHash: '0'.repeat(64) },
      }).outcome,
    ).toBe('different-input-cut')
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
