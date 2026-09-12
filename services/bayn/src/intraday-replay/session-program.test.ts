import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { retainedReplayFixture } from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { prepareReplaySession } from './session-program'
const fixture = () => {
  const source = retainedReplayFixture()
  const { verification: _verification, ...build } = config.build
  return {
    schemaVersion: 'bayn.execution-replay-session.v1',
    replicate: 'validation-test',
    sessionDate: '2026-09-04',
    source: {
      ...source.manifest,
      coverageStartMs: Date.parse('2026-09-04T13:30:00Z'),
      coverageEndMs: Date.parse('2026-09-04T20:00:00Z'),
    },
    openingCashMicros: '100000000000',
    fractionalTrading: false,
    calendar: source.input.input.calendar,
    assets: source.input.protocol.universe.map((symbol, index) => ({
      id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
      symbol,
      class: 'us_equity',
      exchange: 'NASDAQ',
      status: 'active',
      tradable: true,
      fractionable: true,
    })),
    assetObservationAt: '2026-09-04T13:29:00.000Z',
    assetObservationPolicy: 'retained-as-of-session',
    build,
    assumptions: { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
    cadence: {
      pollIntervalMs: 30000,
      reconciliationIntervalMs: 30000,
      reconciliationPassTimeoutMs: 30000,
      reconciliationStaleThresholdMs: 120000,
    },
  }
}
test('session preparation freezes the unchanged strategy and complete calendar interval', () => {
  const input = fixture()
  const first = Result.getOrThrow(prepareReplaySession(input))
  expect(first.openMs).toBe(Date.parse('2026-09-04T13:30:00Z'))
  expect(first.closeMs).toBe(Date.parse('2026-09-04T20:00:00Z'))
  expect(first.identity.accountId).toBe(`replay-${first.runId}`)
  expect(first.runId).toBe(Result.getOrThrow(prepareReplaySession(input)).runId)
  expect(first.runId).not.toBe(Result.getOrThrow(prepareReplaySession({ ...input, replicate: 'separate-run' })).runId)
})
test('session preparation rejects changed strategy, partial hours, unknown calendar and future as-of metadata', () => {
  const input = fixture()
  for (const invalid of [
    { ...input, source: { ...input.source, positions: [...input.source.positions].reverse() } },
    { ...input, build: { ...input.build, strategyBehaviorHash: '0'.repeat(64) } },
    { ...input, source: { ...input.source, coverageStartMs: Date.parse('2026-09-04T14:30:00Z') } },
    { ...input, source: { ...input.source, coverageEndMs: Date.parse('2026-09-04T19:00:00Z') } },
    { ...input, calendar: [] },
    { ...input, assets: input.assets.slice(1) },
    { ...input, assets: [...input.assets, { ...input.assets[0], symbol: 'XYZ' }] },
    { ...input, assetObservationAt: '2026-09-05T00:00:00.000Z' },
  ])
    expect(Result.isFailure(prepareReplaySession(invalid))).toBe(true)
  expect(
    Result.isSuccess(
      prepareReplaySession({
        ...input,
        assetObservationAt: '2026-09-05T00:00:00.000Z',
        assetObservationPolicy: 'counterfactual-current-asset-eligibility',
      }),
    ),
  ).toBe(true)
})

test('asset response ordering cannot change replay identity or broker configuration', () => {
  const input = fixture()
  const canonical = Result.getOrThrow(prepareReplaySession(input))
  const reordered = Result.getOrThrow(prepareReplaySession({ ...input, assets: [...input.assets].reverse() }))
  expect(reordered.runId).toBe(canonical.runId)
  expect(reordered.input).toEqual(canonical.input)
  expect(reordered.assets).toEqual(canonical.assets)
})

test('session preparation permits the broker calendar to include the next trading session', () => {
  const input = fixture()
  const prepared = Result.getOrThrow(
    prepareReplaySession({
      ...input,
      calendar: [...input.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }],
    }),
  )
  expect(prepared.openMs).toBe(Date.parse('2026-09-04T13:30:00Z'))
  expect(prepared.closeMs).toBe(Date.parse('2026-09-04T20:00:00Z'))
  expect(prepared.input.calendar).toHaveLength(2)
})

test('prior calendar sessions fail preparation before a fresh database can be occupied', () => {
  const input = fixture()
  const result = prepareReplaySession({
    ...input,
    calendar: [{ date: '2026-09-03', open: '09:30', close: '16:00' }, ...input.calendar],
  })
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      message: 'A fresh single-session replay cannot include prior calendar sessions',
    })
})
