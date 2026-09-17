import { ReconciliationStatus } from '../execution/contracts'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { retainedReplayFixture, retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { prepareBacktest as prepareWithCapture, assessBacktestSession, BacktestIssue } from './backtest'
import { IntradayExitTiming } from '../strategy/intraday-momentum/research'
import { prepareObserveStartup } from '../observe-composition/startup'
import { validateBacktestSourceReceipt } from './source'
import { sha256 } from '../hash'
import { validateResearchCapitalGrantProof } from '../execution/capital-grant-algebra'
import { makeStrategyProtocolHashResult } from '../contracts'
const fixture = () => {
  const source = retainedReplayFixture()
  const { verification: _verification, ...build } = config.build
  return {
    schemaVersion: 'bayn.backtest.v1',
    replicate: 'validation-test',
    sessionDates: ['2026-09-04'],
    source: {
      ...source.manifest,
      coverageStartMs: Date.parse('2026-09-04T13:30:00Z'),
      coverageEndMs: Date.parse('2026-09-04T20:00:00Z'),
      firstAvailableAtMs: Date.parse('2026-09-04T13:30:00Z'),
      lastAvailableAtMs: Date.parse('2026-09-04T20:00:00Z'),
    },
    openingCashMicros: '100000000000',
    fractionalTrading: false,
    calendar: [...source.input.input.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }],
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
  const first = Result.getOrThrow(prepareBacktest(input))
  expect(first.openMs).toBe(Date.parse('2026-09-04T13:30:00Z'))
  expect(first.closeMs).toBe(Date.parse('2026-09-04T20:00:00Z'))
  expect(first.identity.accountId).toBe(`replay-${first.runId}`)
  expect(first.runId).toBe(Result.getOrThrow(prepareBacktest(input)).runId)
  expect(first.runId).not.toBe(Result.getOrThrow(prepareBacktest({ ...input, replicate: 'separate-run' })).runId)
})

test('explicit exit-timing research binds both close boundaries while preserving signal rules and build identity', () => {
  const input = fixture()
  const baseline = Result.getOrThrow(prepareBacktest(input))
  const identities = new Set<string>()
  for (const [exitTiming, minutes] of [
    [IntradayExitTiming.Current, baseline.protocol.flattenBeforeCloseMinutes],
    [IntradayExitTiming.FifteenMinutes, 15],
    [IntradayExitTiming.ThirtyMinutes, 30],
  ] as const) {
    const research = Result.getOrThrow(prepareBacktest({ ...input, schemaVersion: 'bayn.backtest.v2', exitTiming }))
    if (research.research === undefined) throw new Error('Research identity is required for v2 inputs')
    const entryCutoff = Math.max(minutes, baseline.protocol.entryCutoffMinutesBeforeClose)
    expect(research.protocol).toEqual({
      ...baseline.protocol,
      flattenBeforeCloseMinutes: minutes,
      entryCutoffMinutesBeforeClose: entryCutoff,
      executionModel: {
        ...baseline.protocol.executionModel,
        order: { ...baseline.protocol.executionModel.order, submissionCutoffBeforeCloseMs: entryCutoff * 60_000 },
      },
    })
    expect(research.strategy.provenance.strategy.parameterHash).toBe(research.research.effectiveParameterHash)
    expect(research.research).toMatchObject({
      variant: exitTiming,
      baselineParameterHash: baseline.input.build.strategyParameterHash,
    })
    expect(research.buildEvidence).toEqual(baseline.buildEvidence)
    expect(research.runtimeBuild).toEqual({
      ...baseline.runtimeBuild,
      strategyParameterHash: research.research.effectiveParameterHash,
    })
    const strategy = research.strategy.provenance.strategy
    const proof = {
      schemaVersion: 'bayn.research-paper-grant-proof.v1' as const,
      grant: { _tag: 'Research' as const, planHash: '0'.repeat(64) },
      activationSourceRevision: input.build.sourceRevision,
      activationImageRepository: input.build.imageRepository,
      activationImageDigest: input.build.imageDigest,
      strategyName: strategy.name,
      strategyBehaviorHash: strategy.behaviorHash,
      strategyParameterHash: strategy.parameterHash,
      strategyParameterSchemaVersion: strategy.parameterSchemaVersion,
      strategyProtocolHash: Result.getOrThrow(makeStrategyProtocolHashResult(strategy)),
      accountId: research.identity.accountId,
      brokerIdentityHash: research.identity.identityHash,
      riskPolicyHash: '0'.repeat(64),
      proofPlanHash: '0'.repeat(64),
    }
    const binding = {
      proof,
      sourceGenerationHash: '0'.repeat(64),
      accountId: research.identity.accountId,
      brokerIdentityHash: research.identity.identityHash,
    }
    expect(Result.isSuccess(validateResearchCapitalGrantProof({ ...binding, build: research.runtimeBuild }))).toBe(true)
    expect(Result.isSuccess(validateResearchCapitalGrantProof({ ...binding, build: baseline.runtimeBuild }))).toBe(
      exitTiming === IntradayExitTiming.Current,
    )
    const startup = {
      accountId: research.identity.accountId,
      authorityGenerationHash: '0'.repeat(64),
      strategy: research.strategy,
      ...input.cadence,
    }
    expect(Result.isSuccess(prepareObserveStartup(startup))).toBe(exitTiming === IntradayExitTiming.Current)
    const simulation = { runId: research.runId, exitTiming }
    expect(Result.isSuccess(prepareObserveStartup({ ...startup, simulation }))).toBe(true)
    expect(Result.isFailure(prepareObserveStartup({ ...startup, accountId: 'ordinary-account', simulation }))).toBe(
      true,
    )
    expect(
      Result.isFailure(prepareObserveStartup({ ...startup, simulation: { ...simulation, runId: 'invalid' } })),
    ).toBe(true)
    expect(
      Result.isSuccess(
        prepareObserveStartup({
          ...startup,
          simulation: { ...simulation, exitTiming: IntradayExitTiming.Current },
        }),
      ),
    ).toBe(exitTiming === IntradayExitTiming.Current)
    expect(research.input.assumptions).toEqual(baseline.input.assumptions)
    expect(research.runId).not.toBe(baseline.runId)
    identities.add(research.runId)
  }
  expect(identities.size).toBe(3)
  expect(Result.getOrThrow(prepareBacktest(input)).protocol).toEqual(baseline.protocol)
})

test('research cannot override source identity, arbitrary parameters, or an undeclared v1 exit policy', () => {
  const input = fixture()
  const research = { ...input, schemaVersion: 'bayn.backtest.v2', exitTiming: IntradayExitTiming.FifteenMinutes }
  for (const invalid of [
    { ...input, exitTiming: IntradayExitTiming.FifteenMinutes },
    { ...research, exitTiming: 'CLOSE_AT_LOOKAHEAD_BEST_PRICE' },
    { ...research, protocol: { minimumLookbackReturnBps: 0 } },
    { ...research, build: { ...input.build, strategyParameterHash: '0'.repeat(64) } },
    { ...research, build: { ...input.build, strategyBehaviorHash: '0'.repeat(64) } },
  ])
    expect(Result.isFailure(prepareBacktest(invalid))).toBe(true)
})

test('calendar must include a successor session before a backtest can start', () => {
  const input = fixture()
  const result = prepareBacktest({
    ...input,
    calendar: input.calendar.filter((session) => session.date <= '2026-09-04'),
  })
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      message: 'Backtest calendar must include the next broker session after the final replay session',
    })
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
    expect(Result.isFailure(prepareBacktest(invalid))).toBe(true)
  expect(
    Result.isSuccess(
      prepareBacktest({
        ...input,
        assetObservationAt: '2026-09-05T00:00:00.000Z',
        assetObservationPolicy: 'counterfactual-current-asset-eligibility',
      }),
    ),
  ).toBe(true)
})

test('independently pinned full-session coverage permits quiet opening and closing intervals', () => {
  const input = fixture()
  const source = {
    ...input.source,
    firstAvailableAtMs: Date.parse('2026-09-04T13:31:00Z'),
    lastAvailableAtMs: Date.parse('2026-09-04T19:59:00Z'),
  }
  expect(Result.isSuccess(prepareBacktest({ ...input, source }))).toBe(true)
})

test('asset response ordering cannot change replay identity or broker configuration', () => {
  const input = fixture()
  const canonical = Result.getOrThrow(prepareBacktest(input))
  const reordered = Result.getOrThrow(prepareBacktest({ ...input, assets: [...input.assets].reverse() }))
  expect(reordered.runId).toBe(canonical.runId)
  expect(reordered.input).toEqual(canonical.input)
  expect(reordered.assets).toEqual(canonical.assets)
})

test('the broker calendar successor does not extend the execution interval', () => {
  const input = fixture()
  const prepared = Result.getOrThrow(
    prepareBacktest({
      ...input,
      calendar: input.calendar,
    }),
  )
  expect(prepared.openMs).toBe(Date.parse('2026-09-04T13:30:00Z'))
  expect(prepared.closeMs).toBe(Date.parse('2026-09-04T20:00:00Z'))
  expect(prepared.input.calendar).toHaveLength(2)
})

test('prior calendar sessions fail preparation before a fresh database can be occupied', () => {
  const input = fixture()
  const result = prepareBacktest({
    ...input,
    calendar: [{ date: '2026-09-03', open: '09:30', close: '16:00' }, ...input.calendar],
  })
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      message: 'A fresh backtest cannot include prior calendar sessions',
    })
})

test('normalized asset attributes determine identity independent of response representation', () => {
  const input = fixture()
  const base = Result.getOrThrow(prepareBacktest(input))
  for (const attributes of [undefined, null, []]) {
    const prepared = Result.getOrThrow(
      prepareBacktest({
        ...input,
        assets: input.assets.map((asset) => ({ ...asset, ...(attributes === undefined ? {} : { attributes }) })),
      }),
    )
    expect(prepared.runId).toBe(base.runId)
    expect(prepared.assets).toEqual(base.assets)
  }
  const prepare = (attributes: string[]) =>
    Result.getOrThrow(prepareBacktest({ ...input, assets: input.assets.map((asset) => ({ ...asset, attributes })) }))
  expect(prepare(['ipo', 'ptp_no_exception', 'ipo']).runId).toBe(prepare(['ptp_no_exception', 'ipo']).runId)
  expect(prepare(['ipo']).runId).not.toBe(base.runId)
})

const prepareBacktest = (input: unknown) => prepareWithCapture(input, retainedReplayCaptureFixture(fixture().source))

test('one backtest binds consecutive sessions and normalizes their order', () => {
  const base = fixture()
  const input = {
    ...base,
    sessionDates: ['2026-09-04', '2026-09-08'],
    calendar: [...base.calendar, { date: '2026-09-09', open: '09:30', close: '16:00' }],
    source: {
      ...base.source,
      coverageEndMs: Date.parse('2026-09-08T20:00:00Z'),
      lastAvailableAtMs: Date.parse('2026-09-08T20:00:00Z'),
    },
  }
  const capture = retainedReplayCaptureFixture(input.source)
  const prepared = Result.getOrThrow(prepareWithCapture(input, capture))
  expect(prepared.sessions.map((session) => session.date)).toEqual(input.sessionDates)
  expect(prepared.closeMs).toBe(input.source.coverageEndMs)
  expect(
    Result.getOrThrow(prepareWithCapture({ ...input, sessionDates: [...input.sessionDates].reverse() }, capture)).runId,
  ).toBe(prepared.runId)
  for (const sessionDates of [[], ['2026-09-04', '2026-09-04'], ['2026-09-04', '2026-09-07']])
    expect(Result.isFailure(prepareWithCapture({ ...input, sessionDates }, capture))).toBe(true)
})

test('continuous backtesting rejects an omitted intervening trading session', () => {
  const base = fixture()
  const input = {
    ...base,
    sessionDates: ['2026-09-04', '2026-09-09'],
    calendar: [
      ...base.calendar,
      { date: '2026-09-09', open: '09:30', close: '16:00' },
      { date: '2026-09-10', open: '09:30', close: '16:00' },
    ],
  }
  const result = prepareWithCapture(input, retainedReplayCaptureFixture(input.source))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      message: 'A continuous backtest cannot skip calendar sessions between its boundaries',
    })
})

test('obsolete single-session input is rejected by the canonical backtest command', () => {
  const input = fixture()
  expect(
    Result.isFailure(
      prepareBacktest({
        ...input,
        schemaVersion: 'bayn.execution-replay-session.v1',
        sessionDate: '2026-09-04',
      }),
    ),
  ).toBe(true)
})

test('run identity binds the independent capture receipt as well as the session input', () => {
  const input = fixture()
  const original = retainedReplayCaptureFixture(input.source)
  const text = JSON.stringify({ ...original.value, origin: 'a separately captured observation' })
  const other = Result.getOrThrow(validateBacktestSourceReceipt(text, sha256(text)))
  expect(Result.getOrThrow(prepareWithCapture(input, other)).runId).not.toBe(
    Result.getOrThrow(prepareWithCapture(input, original)).runId,
  )
})

test('a completed schedule only qualifies economics with exact accounting and no unresolved exposure', () => {
  const exact = {
    failedPassCount: 0,
    valuationFailureCount: 0,
    remainingPositionCount: 0,
    reconciliation: {
      status: ReconciliationStatus.Exact,
      unknownOrderCount: 0,
      unknownMutationCount: 0,
      metrics: {
        accountingExact: true,
        discrepancyCount: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
      },
    },
  }
  expect(assessBacktestSession(exact)).toEqual({ completion: 'COMPLETE', issues: [] })
  expect(assessBacktestSession({ ...exact, valuationFailureCount: 1 })).toEqual({
    completion: 'INCOMPLETE',
    issues: [BacktestIssue.MissingValuation],
  })
  expect(assessBacktestSession({ ...exact, failedPassCount: 1 })).toEqual({
    completion: 'INCOMPLETE',
    issues: [BacktestIssue.CycleFailure],
  })
  expect(assessBacktestSession({ ...exact, remainingPositionCount: 1 })).toEqual({
    completion: 'INCOMPLETE',
    issues: [BacktestIssue.UnclosedPosition],
  })
  for (const metrics of [
    { ...exact.reconciliation.metrics, accountingExact: false },
    { ...exact.reconciliation.metrics, discrepancyCount: 1 },
    { ...exact.reconciliation.metrics, cashDifferenceMicros: '1' },
    { ...exact.reconciliation.metrics, positionDifferenceMicros: '1' },
    { ...exact.reconciliation.metrics, equityDifferenceMicros: '1' },
  ])
    expect(assessBacktestSession({ ...exact, reconciliation: { ...exact.reconciliation, metrics } })).toEqual({
      completion: 'INCOMPLETE',
      issues: [BacktestIssue.InexactAccounting],
    })
  for (const reconciliation of [
    { ...exact.reconciliation, unknownOrderCount: 1 },
    { ...exact.reconciliation, unknownMutationCount: 1 },
  ])
    expect(assessBacktestSession({ ...exact, reconciliation })).toEqual({
      completion: 'INCOMPLETE',
      issues: [BacktestIssue.UnresolvedMutation],
    })
})
