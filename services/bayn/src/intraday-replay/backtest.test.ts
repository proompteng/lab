import { jevInstructions } from '../jev/instructions'
import { replayTestInstruments } from '../testing/replay-instruments'
import { cryptoMarketProfile, equityMarketProfile } from '../jev/markets'
import { ReconciliationStatus } from '../execution/contracts'
import { expect, test } from 'bun:test'
import { Effect, FileSystem, Layer, Result, Schema } from 'effect'
import { NodeServices } from '@effect/platform-node'
import { TestClock } from 'effect/testing'
import { JevProtocolSchema } from '../jev/protocol'
import { JevBatchPlanVersion } from '../jev/batch'
import { strictParseOptions } from '../schemas'
import { nativeJevFixture } from '../jev/native.test-support'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { makeControlEntryObservation } from './control-entry'
import { createControlPortfolio } from './control-portfolio'
import { makeControlJevJournal } from './control-jev-journal'
import { retainedReplayFixture, retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import {
  prepareBacktest as prepareWithCapture,
  assessBacktestSession,
  BacktestIssue,
  qualifiesReplayValuation,
} from './backtest'
import { jevModel } from '../jev/contract'
import { prepareObserveStartup } from '../observe-composition/startup'
import { backtestSourcePartitions, validateBacktestSourceReceipt } from './source'
import { sha256, canonicalHashV1Result } from '../hash'
import { validateResearchCapitalGrantProof } from '../execution/capital-grant-algebra'
import { makeStrategyProtocolHashResult } from '../contracts'
const fixture = () => {
  const source = retainedReplayFixture()
  const { verification: _verification, ...build } = config.build
  return {
    schemaVersion: 'bayn.backtest.v5',
    jevInstructionsHash: Result.getOrThrow(canonicalHashV1Result(jevInstructions)),
    inference: {
      mode: 'measured-provider',
      maximumCalls: 1000,
      model: jevModel,
      inputDefinition: 'bayn.jev-trading-signal-state.v18',
      costs: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
    },
    allocatedDataCostPerSessionMicros: '0',
    replicate: 'validation-test',
    interval: { startAt: '2026-09-04T13:30:00.000Z', endAt: '2026-09-04T20:00:00.000Z' },
    source: {
      ...source.manifest,
      coverageStartMs: Date.parse('2026-09-04T13:30:00Z'),
      coverageEndMs: Date.parse('2026-09-04T20:00:00Z'),
      firstAvailableAtMs: Date.parse('2026-09-04T13:30:00Z'),
      lastAvailableAtMs: Date.parse('2026-09-04T20:00:00Z'),
    },
    openingCashMicros: '100000000000',
    fractionalTrading: false,
    calendar: [
      ...source.input.input.calendar,
      { session_open: '0930', session_close: '1600', date: '2026-09-08', open: '09:30', close: '16:00' },
    ],
    assets: equityMarketProfile.universe.map((symbol, index) => ({
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
    assumptions: {
      instruments: replayTestInstruments,
      latencyMs: 100,
      slippageBps: 0,
      availableLiquidityPpm: 1000000,
      feeMultiplierPpm: 1000000,
    },
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

test('broker sessions retain regular hours when the provider includes wider data hours', () => {
  const input = fixture()
  const calendar = input.calendar.map((session) => ({ ...session, session_open: '0400', session_close: '2000' }))
  const prepared = Result.getOrThrow(prepareBacktest({ ...input, calendar }))
  expect(prepared.brokerSessions).toEqual([
    { date: '2026-09-04', openAt: '2026-09-04T13:30:00.000Z', closeAt: '2026-09-04T20:00:00.000Z' },
  ])
  expect(Result.getOrThrow(canonicalHashV1Result(prepared.input.calendar))).toBe(
    Result.getOrThrow(canonicalHashV1Result(calendar)),
  )
  expect(prepared.input.interval).toEqual(input.interval)
})

test('broker sessions retain an early regular close inside wider provider hours', () => {
  const input = fixture()
  const prepared = Result.getOrThrow(
    prepareBacktest({
      ...input,
      interval: { ...input.interval, endAt: '2026-09-04T17:00:00.000Z' },
      calendar: input.calendar.map((session) => ({
        ...session,
        ...(session.date === '2026-09-04' ? { close: '13:00' } : {}),
        session_open: '0400',
        session_close: '2000',
      })),
    }),
  )
  expect(prepared.brokerSessions).toEqual([
    { date: '2026-09-04', openAt: '2026-09-04T13:30:00.000Z', closeAt: '2026-09-04T17:00:00.000Z' },
  ])
})

test('native backtest binds Jev identity, provider cost assumptions and the unchanged financial grant', () => {
  const input = fixture()
  const prepared = Result.getOrThrow(prepareBacktest(input))
  expect(prepared.strategy.provenance.strategy.name).toBe('jev')
  expect(prepared.protocol.schemaVersion).toBe('bayn.jev.protocol.v21')
  expect(prepared.protocol.model).toBe(jevModel)
  expect(prepared.input.inference.inputDefinition).toBe(prepared.protocol.inputDefinition)
  expect(prepared.runtimeBuild).toMatchObject(input.build)
  const strategy = prepared.strategy.provenance.strategy
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
    accountId: prepared.identity.accountId,
    brokerIdentityHash: prepared.identity.identityHash,
    riskPolicyHash: '0'.repeat(64),
    proofPlanHash: '0'.repeat(64),
  }
  expect(
    Result.isSuccess(
      validateResearchCapitalGrantProof({
        proof,
        sourceGenerationHash: '0'.repeat(64),
        accountId: prepared.identity.accountId,
        brokerIdentityHash: prepared.identity.identityHash,
        build: prepared.runtimeBuild,
      }),
    ),
  ).toBe(true)
  expect(
    Result.isSuccess(
      prepareObserveStartup({
        accountId: prepared.identity.accountId,
        authorityGenerationHash: '0'.repeat(64),
        strategy: prepared.strategy,
        ...input.cadence,
      }),
    ),
  ).toBe(true)
  expect(Result.getOrThrow(prepareBacktest({ ...input, allocatedDataCostPerSessionMicros: '1000000' })).runId).not.toBe(
    prepared.runId,
  )
  expect(
    Result.getOrThrow(
      prepareBacktest({
        ...input,
        inference: { ...input.inference, costs: { ...input.inference.costs, inputMicrosPerMillionTokens: '84000' } },
      }),
    ).runId,
  ).not.toBe(prepared.runId)
})

test('native backtest rejects retired momentum inputs, missing inference provenance and arbitrary parameters', () => {
  const input = fixture()
  for (const invalid of [
    { ...input, schemaVersion: 'bayn.backtest.v1' },
    { ...input, schemaVersion: 'bayn.backtest.v2', exitTiming: 'current' },
    { ...input, exitTiming: 'current' },
    { ...input, inference: undefined },
    { ...input, jevInstructionsHash: '0'.repeat(64) },
    { ...input, inference: { ...input.inference, maximumCalls: 0 } },
    { ...input, inference: { ...input.inference, mode: 'constant-response' } },
    { ...input, inference: { ...input.inference, model: 'unverified' } },
    { ...input, inference: { ...input.inference, inputDefinition: 'bayn.jev-trading-signal-state.v4' } },
    {
      ...input,
      inference: { ...input.inference, costs: { ...input.inference.costs, inputMicrosPerMillionTokens: '0' } },
    },
    { ...input, protocol: { minimumLookbackReturnBps: 0 } },
    { ...input, build: { ...input.build, strategyParameterHash: '0'.repeat(64) } },
    { ...input, build: { ...input.build, strategyBehaviorHash: '0'.repeat(64) } },
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
      message: 'Backtest calendar must include the next broker session after the replay interval',
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

test('retained predecessor calendar sessions do not change a frozen execution interval', () => {
  const input = fixture()
  const prepared = Result.getOrThrow(
    prepareBacktest({
      ...input,
      calendar: [
        { session_open: '0930', session_close: '1600', date: '2026-09-03', open: '09:30', close: '16:00' },
        ...input.calendar,
      ],
    }),
  )
  expect(prepared.openMs).toBe(Date.parse(input.interval.startAt))
  expect(prepared.closeMs).toBe(Date.parse(input.interval.endAt))
})

test('a declared mixed-market weekend interval preserves one account, broker assets and the unchanged strategy', () => {
  const base = fixture()
  const crypto = {
    universeId: cryptoMarketProfile.universeId,
    universeSymbolHash: cryptoMarketProfile.universeSymbolHash,
    symbols: cryptoMarketProfile.universe,
    topics: { ...cryptoMarketProfile.sourceTopics, features: cryptoMarketProfile.streamingInput.featureTopic },
  }
  const interval = { startAt: '2026-09-05T23:45:00.000Z', endAt: '2026-09-06T00:15:00.000Z' }
  const material = {
    ...base.source,
    marketSources: [...base.source.marketSources, crypto] as const,
    coverageStartMs: Date.parse(interval.startAt),
    coverageEndMs: Date.parse(interval.endAt),
    firstAvailableAtMs: Date.parse(interval.startAt),
    lastAvailableAtMs: Date.parse(interval.endAt),
  }
  const positions = new Map(
    base.source.positions.map((position) => [`${position.topic}:${position.partition}`, position]),
  )
  const source = {
    ...material,
    positions: backtestSourcePartitions(material).map(
      ({ topic, partition }) =>
        positions.get(`${topic}:${partition}`) ?? { topic, partition, startOffset: '0', endOffsetExclusive: '0' },
    ),
  }
  const input = {
    ...base,
    interval,
    source,
    assets: [
      ...base.assets,
      ...cryptoMarketProfile.universe.map((symbol, index) => ({
        id: `87654321-1234-4234-8234-${String(index).padStart(12, '0')}`,
        symbol,
        class: 'crypto',
        exchange: 'CRYPTO',
        status: 'active',
        tradable: true,
        fractionable: true,
        min_order_size: '0.00001',
        min_trade_increment: '0.000000001',
        price_increment: '0.01',
      })),
    ],
  }
  const prepared = Result.getOrThrow(prepareWithCapture(input, retainedReplayCaptureFixture(source)))
  expect(prepared.openMs).toBe(Date.parse(interval.startAt))
  expect(prepared.closeMs).toBe(Date.parse(interval.endAt))
  expect(prepared.reportingWindows.map((session) => session.date)).toEqual(['2026-09-05', '2026-09-06'])
  expect(prepared.reportingWindows[0]?.closeAt).toBe('2026-09-06T00:00:00.000Z')
  expect(prepared.reportingWindows[1]?.openAt).toBe(prepared.reportingWindows[0]?.closeAt)
  expect(prepared.assets.map((asset) => asset.symbol)).toEqual(input.assets.map((asset) => asset.symbol).sort())
  expect(prepared.strategy.provenance.strategy).toEqual(
    Result.getOrThrow(prepareBacktest(base)).strategy.provenance.strategy,
  )
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

test('one backtest advances continuously across weekends and normalizes its broker calendar', () => {
  const base = fixture()
  const input = {
    ...base,
    interval: { startAt: '2026-09-04T13:30:00.000Z', endAt: '2026-09-08T20:00:00.000Z' },
    calendar: [
      ...base.calendar,
      { session_open: '0930', session_close: '1600', date: '2026-09-09', open: '09:30', close: '16:00' },
    ],
    source: {
      ...base.source,
      coverageEndMs: Date.parse('2026-09-08T20:00:00Z'),
      lastAvailableAtMs: Date.parse('2026-09-08T20:00:00Z'),
    },
  }
  const capture = retainedReplayCaptureFixture(input.source)
  const prepared = Result.getOrThrow(prepareWithCapture(input, capture))
  expect(prepared.reportingWindows.map((session) => session.date)).toEqual([
    '2026-09-04',
    '2026-09-05',
    '2026-09-06',
    '2026-09-07',
    '2026-09-08',
  ])
  for (let index = 1; index < prepared.reportingWindows.length; index++)
    expect(prepared.reportingWindows[index]?.openAt).toBe(prepared.reportingWindows[index - 1]?.closeAt)
  expect(prepared.closeMs).toBe(input.source.coverageEndMs)
  expect(
    Result.getOrThrow(prepareWithCapture({ ...input, calendar: [...input.calendar].reverse() }, capture)).runId,
  ).toBe(prepared.runId)
  for (const sessionDates of [[], ['2026-09-04', '2026-09-04'], ['2026-09-04', '2026-09-07']])
    expect(Result.isFailure(prepareWithCapture({ ...input, sessionDates }, capture))).toBe(true)
})

test('continuous backtesting rejects an interval whose source stops before the requested end', () => {
  const base = fixture()
  const input = {
    ...base,
    interval: { startAt: '2026-09-04T13:30:00.000Z', endAt: '2026-09-09T20:00:00.000Z' },
    calendar: [
      ...base.calendar,
      { session_open: '0930', session_close: '1600', date: '2026-09-09', open: '09:30', close: '16:00' },
      { session_open: '0930', session_close: '1600', date: '2026-09-10', open: '09:30', close: '16:00' },
    ],
  }
  const result = prepareWithCapture(input, retainedReplayCaptureFixture(input.source))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      message: 'Frozen source receipt does not cover market open through close',
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
    finalWindow: true,
    failedPassCount: 0,
    unavailableDecisionPassCount: 0,
    valuationFailureCount: 0,
    remainingPositionCount: 0,
    remainingOpenOrderCount: 0,
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
  expect(assessBacktestSession({ ...exact, remainingOpenOrderCount: 1 })).toEqual({
    completion: 'INCOMPLETE',
    issues: [BacktestIssue.UnclosedOrder],
  })
  expect(assessBacktestSession({ ...exact, finalWindow: false, remainingOpenOrderCount: 1 })).toEqual({
    completion: 'COMPLETE',
    issues: [],
  })
  expect(assessBacktestSession({ ...exact, unavailableDecisionPassCount: 1 })).toEqual({
    completion: 'INCOMPLETE',
    issues: [BacktestIssue.MissingDecisionData],
  })
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
  expect(assessBacktestSession({ ...exact, finalWindow: false, remainingPositionCount: 1 })).toEqual({
    completion: 'COMPLETE',
    issues: [],
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

test('stale held-position marks do not qualify replay economics', () => {
  const mark = {
    symbol: 'AAPL',
    priceMicros: '100000000',
    eventAt: '2026-09-08T13:30:00.000Z',
    availableAtMs: Date.parse('2026-09-08T13:30:00.000Z'),
    ageNanos: '1000000000',
    staleForExecution: false,
    bidLiquidityAvailable: true,
    topic: 'quotes',
    partition: 0,
    offset: '1',
    recordHash: 'a'.repeat(64),
  }
  const valuation = { model: 'last-observed-bid' as const, observedAt: '2026-09-08T13:30:01.000Z' }
  expect(qualifiesReplayValuation({ ...valuation, marks: [] })).toBe(true)
  expect(qualifiesReplayValuation({ ...valuation, marks: [mark] })).toBe(true)
  expect(qualifiesReplayValuation({ ...valuation, marks: [{ ...mark, staleForExecution: true }] })).toBe(false)
  expect(qualifiesReplayValuation({ ...valuation, marks: [{ ...mark, bidLiquidityAvailable: false }] })).toBe(false)
})

test('prepared replay preserves the strict native protocol independently of the equity source profile', () => {
  const prepared = Result.getOrThrow(prepareBacktest(fixture()))
  const decoded = Result.getOrThrow(
    Schema.decodeUnknownResult(JevProtocolSchema, strictParseOptions)(prepared.protocol),
  )
  expect(decoded.universe).toContain('BTC/USD')
  expect(prepared.input.source.marketSources.flatMap((source) => source.symbols)).toEqual([
    ...equityMarketProfile.universe,
  ])
})

test('prepared replay admits a native control batch before any provider dispatch', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prepared = Result.getOrThrow(prepareBacktest(fixture()))
      const snapshot = nativeJevFixture().snapshot
      const observation = Result.getOrThrow(
        makeControlEntryObservation({
          runId: prepared.runId,
          protocol: prepared.protocol,
          snapshot,
          portfolio: Result.getOrThrow(createControlPortfolio(prepared.input.openingCashMicros)),
        }),
      )
      const plan = Result.getOrThrow(
        makeJevTradingSignalBatch({
          observation: observation.payload,
          planVersion: JevBatchPlanVersion.V6,
          expiresAt: new Date(
            Date.parse(observation.payload.observedAt) + prepared.protocol.inferenceValidityMs,
          ).toISOString(),
        }),
      )
      const fs = yield* FileSystem.FileSystem
      const directory = `${yield* fs.makeTempDirectoryScoped()}/journal`
      const journal = yield* makeControlJevJournal(directory, prepared.runId)
      yield* TestClock.setTime(Date.parse(observation.payload.observedAt))
      const admitted = yield* journal.batches.begin(plan, observation.payload)
      expect(admitted.dispatches.length).toBeGreaterThan(0)
      for (const dispatch of admitted.dispatches)
        expect(yield* fs.exists(`${directory}/request-${dispatch.request.requestId}.json`)).toBeTrue()
      expect(yield* journal.calls).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  ))
