import { beforeAll, expect, test } from 'bun:test'
import { Result } from 'effect'
import protocol from './fixtures/frozen-control-protocol.json'
import { JevResearchPolicy } from '../jev/acceptance'
import { frozenControlOrigin, frozenDeployedControlIdentity } from './frozen-control-identity'
import { testHash } from './fixtures.test-support'
import { FrozenControlReplaySchema, frozenReplayReplica, prepareFrozenControlReplay } from './frozen-control-replay'

import { frozenControlReplayFixture } from './frozen-control.test-support'

let fixture: Awaited<ReturnType<typeof frozenControlReplayFixture>>
beforeAll(async () => {
  fixture = await frozenControlReplayFixture()
}, 30000)

const reseal = (input: typeof FrozenControlReplaySchema.Type) => ({
  ...input,
  backtest: { ...input.backtest, replicate: Result.getOrThrow(frozenReplayReplica(input, fixture.captureHash)) },
})
const prepare = (input: unknown) => prepareFrozenControlReplay(input, fixture.capture, fixture.captureHash)

test('an original single-position control binds its own registered carrier and original full protocol', () => {
  expect(testHash(protocol)).toBe(frozenDeployedControlIdentity.parametersHash)
  expect(testHash(protocol.executionModel)).toBe(frozenControlOrigin.executionModelHash)
  const prepared = Result.getOrThrow(prepare(fixture.input))
  expect(prepared.definition.policy).toBe(JevResearchPolicy.Deployed)
  expect(prepared.stress.p95FullBatchMs).toBe(fixture.input.latencyStress.p95FullBatchMs)
  expect(prepared.engineRunId).toMatch(/^[0-9a-f]{64}$/)
  expect(prepared.runId).toBe(testHash(fixture.input))
  expect(Result.getOrThrow(prepare(fixture.input)).engineRunId).toBe(prepared.engineRunId)
})

test('resealing cannot replace the original policy, registered model, calibration, allocation or carrier', () => {
  const input = fixture.input
  for (const changed of [
    { ...input, protocol: { ...input.protocol, flattenBeforeCloseMinutes: 1 } },
    { ...input, latencyStress: { ...input.latencyStress, p95FullBatchMs: input.latencyStress.p95FullBatchMs + 1 } },
    { ...input, backtest: { ...input.backtest, openingCashMicros: '100000000001' } },
    {
      ...input,
      backtest: {
        ...input.backtest,
        assumptions: { ...input.backtest.assumptions, latencyMs: input.backtest.assumptions.latencyMs + 1 },
      },
    },
    { ...input, backtest: { ...input.backtest, build: { ...input.backtest.build, sourceRevision: '1'.repeat(40) } } },
    {
      ...input,
      backtest: {
        ...input.backtest,
        build: { ...input.backtest.build, imageDigest: `sha256:${testHash('another carrier')}` },
      },
    },
    {
      ...input,
      backtest: {
        ...input.backtest,
        source: {
          ...input.backtest.source,
          universe: { ...input.backtest.source.universe, universeId: 'substituted' },
        },
      },
    },
    {
      ...input,
      backtest: {
        ...input.backtest,
        assetObservationAt: new Date(Date.parse(input.backtest.assetObservationAt) + 1).toISOString(),
      },
    },
    {
      ...input,
      backtest: {
        ...input.backtest,
        calendar: input.backtest.calendar.map((day, index) => (index === 0 ? { ...day, open: '99:00' } : day)),
      },
    },
  ])
    expect(Result.isFailure(prepare(reseal(changed)))).toBe(true)
  expect(
    Result.isFailure(prepare({ ...input, backtest: { ...input.backtest, replicate: 'unregistered-repeat' } })),
  ).toBe(true)
  expect(Result.isFailure(prepare({ ...input, policy: JevResearchPolicy.Momentum }))).toBe(true)
  expect(
    Result.isFailure(
      prepare({ ...input, backtest: { ...input.backtest, schemaVersion: 'bayn.backtest.v2', exitTiming: 'changed' } }),
    ),
  ).toBe(true)
}, 30000)

test('capture bytes, causal coverage and all twenty registered sessions remain mandatory', () => {
  const input = fixture.input
  expect(Result.isFailure(prepareFrozenControlReplay(input, fixture.capture + '\n', fixture.captureHash))).toBe(true)
  expect(
    Result.isFailure(
      prepare(
        reseal({ ...input, backtest: { ...input.backtest, sessionDates: input.backtest.sessionDates.slice(1) } }),
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      prepare(reseal({ ...input, backtest: { ...input.backtest, assets: input.backtest.assets.slice(1) } })),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      prepare(
        reseal({
          ...input,
          backtest: { ...input.backtest, cadence: { ...input.backtest.cadence, pollIntervalMs: 1 } },
        }),
      ),
    ),
  ).toBe(true)
})
