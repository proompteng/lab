import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { nativeJevFixture } from '../jev/native.test-support'
import { IntradaySnapshotFailure } from '../market-data/intraday/model'
import { ControlStudyFailure } from './control-portfolio'
import { ControlInputCoverage, scanControlInputs } from './control-preflight'
import type { ControlMarket } from './control-study'

const fixture = nativeJevFixture()
const originalSession = fixture.snapshot.manifest.calendar.sessions[0]
if (originalSession === undefined) throw new Error('Fixture requires a session')
const openMs = Date.parse(originalSession.openAt)
const session = { ...originalSession, closeAt: new Date(openMs + 90 * 60_000).toISOString() }

const scan = (options: { unavailable?: boolean; excludeAll?: boolean; durationMs?: number } = {}) => {
  const observations: number[] = []
  const market: Pick<ControlMarket, 'advanceTo' | 'snapshot'> = {
    advanceTo: () => Effect.void,
    snapshot: (query) =>
      Effect.sync(() => {
        observations.push(Date.parse(query.observedAt))
        expect(Date.parse(query.rangeEndAt)).toBe(Math.floor((Date.parse(query.observedAt) - 2000) / 60_000) * 60_000)
        expect(query.candidateSymbols).toEqual(fixture.protocol.candidateSymbols)
        expect(query.candidateEvidencePolicy).toBe(fixture.protocol.candidateEvidencePolicy)
        if (options.unavailable)
          return {
            status: 'UNAVAILABLE' as const,
            cause: new IntradaySnapshotFailure({ reason: 'not-ready', message: 'No matching benchmark feature' }),
          }
        return {
          status: 'AVAILABLE' as const,
          snapshot: {
            ...fixture.snapshot,
            manifest: {
              ...fixture.snapshot.manifest,
              candidateExclusions: options.excludeAll
                ? fixture.protocol.candidateSymbols.map((symbol) => ({
                    symbol,
                    reason: 'freshness' as const,
                    message: 'Candidate quote is stale',
                  }))
                : [],
            },
          },
        }
      }),
  }
  return {
    observations,
    effect: scanControlInputs({
      protocol: fixture.protocol,
      session:
        options.durationMs === undefined
          ? session
          : { ...session, closeAt: new Date(openMs + options.durationMs).toISOString() },
      calendar: fixture.snapshot.manifest.calendar,
      pollIntervalMs: 30_000,
      market,
    }),
  }
}

test('preflight covers every eligible scheduled poll without consuming repeated minute windows', async () => {
  const input = scan()
  const report = await Effect.runPromise(input.effect)
  expect(report.coverage).toBe(ControlInputCoverage.Complete)
  expect(report.scheduledPollCount).toBe(180)
  expect(report.warmupPollCount).toBe(61)
  expect(report.entryCutoffPollCount).toBe(10)
  expect(report.eligiblePollCount).toBe(109)
  expect(report.availableSnapshotCount).toBe(109)
  expect(report.unavailableSnapshotCount).toBe(0)
  expect(input.observations[0]).toBe(openMs + 30 * 60_000 + 30_000)
  expect(input.observations.at(-1)).toBe(openMs + 84 * 60_000 + 30_000)
  for (const candidate of report.candidates) {
    expect(candidate.availableCount).toBe(109)
    expect(candidate.excludedCount).toBe(0)
    expect(candidate.snapshotUnavailableCount).toBe(0)
  }
})

test('preflight retains unavailable input as missing, not a zero-return or no-signal result', async () => {
  const report = await Effect.runPromise(scan({ unavailable: true }).effect)
  expect(report.coverage).toBe(ControlInputCoverage.Incomplete)
  expect(report.availableSnapshotCount).toBe(0)
  expect(report.unavailableSnapshotCount).toBe(109)
  expect(report.failures).toEqual([
    {
      reason: 'not-ready',
      count: 109,
      firstObservedAt: new Date(openMs + 30 * 60_000 + 30_000).toISOString(),
      firstMessage: 'No matching benchmark feature',
    },
  ])
  expect(report).not.toHaveProperty('netPnlMicros')
  expect(report).not.toHaveProperty('selectedSymbol')
  expect(report.candidates.every((candidate) => candidate.snapshotUnavailableCount === 109)).toBeTrue()
})

test('available benchmark snapshots with every candidate excluded do not pass full-input coverage', async () => {
  const report = await Effect.runPromise(scan({ excludeAll: true }).effect)
  expect(report.coverage).toBe(ControlInputCoverage.Incomplete)
  expect(report.availableSnapshotCount).toBe(109)
  expect(report.unavailableSnapshotCount).toBe(0)
  for (const candidate of report.candidates) {
    expect(candidate.availableCount).toBe(0)
    expect(candidate.excludedCount).toBe(109)
    expect(candidate.exclusionCounts).toEqual({ freshness: 109 })
  }
})

test('sessions with no eligible entry poll are not complete input evidence', async () => {
  const input = scan({ durationMs: 30 * 60_000 })
  const report = await Effect.runPromise(input.effect)
  expect(report.coverage).toBe(ControlInputCoverage.NoEligiblePolls)
  expect(report.eligiblePollCount).toBe(0)
  expect(report.scheduledPollCount).toBe(report.warmupPollCount + report.entryCutoffPollCount)
  expect(input.observations).toEqual([])
})

test('source errors and interruption propagate instead of becoming successful missing-input reports', async () => {
  const args = {
    protocol: fixture.protocol,
    session,
    calendar: fixture.snapshot.manifest.calendar,
    pollIntervalMs: 30_000,
  }
  const failure = new ControlStudyFailure({ message: 'Source bytes failed verification' })
  const failed = await Effect.runPromise(
    Effect.result(
      scanControlInputs({
        ...args,
        market: { advanceTo: () => Effect.fail(failure), snapshot: () => Effect.die('Unexpected snapshot') },
      }),
    ),
  )
  expect(Result.isFailure(failed)).toBeTrue()
  if (Result.isFailure(failed)) expect(failed.failure).toBe(failure)
  let finalized = 0
  const interrupted = await Effect.runPromiseExit(
    scanControlInputs({
      ...args,
      market: {
        advanceTo: () => Effect.interrupt,
        snapshot: () => Effect.die('Unexpected snapshot'),
      },
    }).pipe(Effect.ensuring(Effect.sync(() => finalized++))),
  )
  expect(interrupted._tag).toBe('Failure')
  expect(finalized).toBe(1)
})

test.each([0, -1, 0.5, 60_001, Number.NaN])(
  'invalid cadence %s fails before reading source data',
  async (pollIntervalMs) => {
    const result = await Effect.runPromise(
      Effect.result(
        scanControlInputs({
          protocol: fixture.protocol,
          session,
          calendar: fixture.snapshot.manifest.calendar,
          pollIntervalMs,
          market: {
            advanceTo: () => Effect.die('Invalid cadence cannot advance the source'),
            snapshot: () => Effect.die('Invalid cadence cannot inspect a snapshot'),
          },
        }),
      ),
    )
    expect(Result.isFailure(result)).toBeTrue()
  },
)
