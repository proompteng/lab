import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { gzipSync } from 'node:zlib'
import { Effect, FileSystem, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { OrderSide } from '../execution/contracts'
import { EntryTurnoverPolicy } from '../execution/turnover-reserve'
import { canonicalHashV1 as hash, sha256 } from '../hash'
import { jevModel } from '../jev/contract'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../jev/protocol'
import { observedQuoteAt } from '../market-data/streaming/projection'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import { config } from '../testing/runtime-fixtures'
import { utcInstantFromEpochMillis as iso } from '../time'
import {
  prepareBoundRidge,
  RidgeControlPolicy,
  ridgeExecutionLabelDefinition,
  scorePinnedRidgeCandidates,
  selectBoundRidge,
} from './control-ridge'
import { ControlPolicy, ControlStudyFailure } from './control-portfolio'
import {
  ControlManagementMode,
  makeControlEntryQuery,
  runControlSession,
  runControlStudy,
  type ControlMarket,
} from './control-study'
import { runControlPreflight } from './control-preflight'
import { sixBarResearchDefinition, SixBarResearchStatus } from './six-bar-features'
import {
  replaySixBarFixture,
  sixBarFixture,
  sixBarFixtureInputs,
  sixBarOpenMs,
  type SixBarFixtureInput,
} from './six-bar-features.test-support'
import { SixBarRidgePartition, sixBarRidgeRecipe } from './six-bar-ridge'
import { validateBacktestSourceReceipt, type BacktestSourceManifest } from './source'

const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const firstDecisionMs = sixBarOpenMs + 30 * 60_000 + 30_000
const assumptions = { latencyMs: 100, slippageBps: 1, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 }
const fullCalendar = [
  { date: '2026-09-01', open: '09:30', close: '10:10' },
  { date: '2026-09-04', open: '09:30', close: '10:10' },
  { date: '2026-09-08', open: '09:30', close: '10:10' },
  { date: '2026-09-09', open: '09:30', close: '10:10' },
] as const
const calendar = Result.getOrThrow(
  normalizeMarketCalendarResult(fullCalendar, { start: '2026-09-01', end: '2026-09-09' }),
)
const executionCalendar = Result.getOrThrow(
  normalizeMarketCalendarResult(fullCalendar.slice(1, 3), { start: '2026-09-04', end: '2026-09-08' }),
)
const session = executionCalendar.sessions[0]
if (session === undefined) throw new Error('Missing synthetic session')

const fixture = (
  options: {
    missing?: boolean
    mean?: number
    intercept?: number
    pollIntervalMs?: number
    exclude?: boolean
    exitQuotes?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const risk = yield* loadQuoteBoundExecutionRiskPolicy('ridge-control-test', protocol.universe)
    const pollIntervalMs = options.pollIntervalMs ?? 30_000
    const firstDecisionMs = sixBarOpenMs + Math.ceil(1_802_000 / pollIntervalMs) * pollIntervalMs
    const inputs: SixBarFixtureInput[] = sixBarFixtureInputs()
      .flatMap((input) => {
        const symbols = input.symbol === 'SPY' ? ['SPY'] : protocol.candidateSymbols
        return symbols.map((symbol) => ({
          ...input,
          symbol,
          ...(options.exclude === true && symbol !== 'SPY' && input.channel === 'quotes' ? { askSize: 0 } : {}),
          eventAtMs:
            input.channel === 'quotes' || input.channel === 'trades'
              ? firstDecisionMs - 1000
              : input.eventAtMs + 24 * 60_000,
          availableAtMs:
            input.channel === 'quotes' || input.channel === 'trades'
              ? firstDecisionMs - 1000
              : input.availableAtMs + 24 * 60_000,
        }))
      })
      .filter(
        (input) =>
          !(
            options.missing === true &&
            input.symbol === 'AAPL' &&
            input.channel === 'bars' &&
            input.eventAtMs === sixBarOpenMs + 24 * 60_000
          ),
      )
    if (options.exitQuotes === true)
      for (let atMs = firstDecisionMs + 30_000; atMs <= Date.parse(session.closeAt); atMs += 30_000)
        inputs.push({
          channel: 'quotes',
          symbol: 'AAPL',
          eventAtMs: atMs - 1000,
          availableAtMs: atMs - 1000,
          bid: 104.99,
          ask: 105.01,
          bidSize: 25,
          askSize: 100,
        })
    const captured = sixBarFixture(inputs, '10:10')
    const body = gzipSync(captured.events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const nativeVisiblePartitions = Object.values(captured.universe.topics)
      .sort()
      .map((topic) => ({ topic, partition: 0 }))
    const source: BacktestSourceManifest = {
      schemaVersion: 'bayn.backtest-source.v1',
      encoding: 'ndjson-gzip',
      transport: 'original-capture',
      dataSha256: sha256(body),
      recordCount: captured.events.length,
      coverageStartMs: sixBarOpenMs,
      coverageEndMs: Date.parse(session.closeAt),
      firstAvailableAtMs: captured.events[0]?.availableAtMs ?? 0,
      lastAvailableAtMs: captured.events.at(-1)?.availableAtMs ?? 0,
      origin: 'SYNTHETIC Ridge integration fixture, not market evidence',
      nativeVisiblePartitions,
      positions: nativeVisiblePartitions.map(({ topic, partition }) => ({
        topic,
        partition,
        startOffset: '0',
        endOffsetExclusive: String(captured.events.filter((event) => event.record.topic === topic).length),
      })),
      universe: captured.universe,
      deliveryModel: captured.source.deliveryModel,
    }
    const context = {
      protocol,
      risk,
      pollIntervalMs,
      decisionLatencyMs: 1000,
      turnoverPolicy: EntryTurnoverPolicy.EntryAndExpectedExit,
      assumptions,
      source,
      calendar: executionCalendar,
      sessions: [session],
    }
    const allocationBudgetMicros = '20000000000'
    const payload = {
      schemaVersion: 'bayn.six-bar-ridge-artifact.v2',
      qualification: 'UNQUALIFIED',
      controllerCoverage: 'UNKNOWN',
      recipeHash: hash(sixBarRidgeRecipe),
      featureDefinitionHash: hash(sixBarResearchDefinition),
      featureOrder: sixBarResearchDefinition.features,
      solver: sixBarRidgeRecipe.solver,
      provenance: {
        sourceRevision: '1'.repeat(40),
        sourceManifestHash: sha256('SYNTHETIC training source'),
        calendarHash: calendar.normalizedResponseHash,
        labelDefinitionHash: hash(ridgeExecutionLabelDefinition(context, allocationBudgetMicros)),
      },
      allocationBudgetMicros,
      manifestHash: sha256('SYNTHETIC frozen training manifest'),
      trainingDataHash: sha256('SYNTHETIC training rows'),
      fitCutoffAt: '2026-09-02T00:00:00.000Z',
      firstEvaluationDecisionAt: iso(firstDecisionMs),
      evaluationSessions: calendar.sessions
        .filter((entry) => entry.date === '2026-09-04' || entry.date === '2026-09-08')
        .map((entry) => ({
          ...entry,
          firstDecisionAt: iso(Date.parse(entry.openAt) + Math.ceil(1_802_000 / pollIntervalMs) * pollIntervalMs),
          partition: entry.date === '2026-09-04' ? SixBarRidgePartition.Validation : SixBarRidgePartition.Holdout,
        })),
      trainingSessions: [{ date: '2026-09-01', rowCount: 1 }],
      trainingRows: 1,
      nonemptyTrainingDays: 1,
      means: [0, 0, 0, 0, 0, 0, 0],
      scales: [0, 0, 0, 0, 0, 0, 0],
      coefficients: [0, 0, 0, 0, 0, 0, 0],
      intercept: options.intercept ?? 5,
      trainingTargetMeanBps: options.mean ?? 5,
    }
    const artifact = { ...payload, artifactHash: hash(payload) }
    const input = {
      artifact,
      expectedArtifact: {
        artifactHash: artifact.artifactHash,
        manifestHash: artifact.manifestHash,
        sourceRevision: artifact.provenance.sourceRevision,
      },
      calendar: fullCalendar,
      expectedCalendarHash: calendar.normalizedResponseHash,
      evaluationSourceManifestHash: hash(source),
      partition: SixBarRidgePartition.Validation,
    }
    const bound = yield* Effect.fromResult(prepareBoundRidge(input, context))
    const actualCapture = { ...captured, source: { ...captured.source, sourceManifestHash: hash(source) } }
    const query = makeControlEntryQuery({
      protocol,
      calendar: executionCalendar,
      sessionDate: '2026-09-04',
      observedAtMs: firstDecisionMs,
      candidates: protocol.candidateSymbols,
    })
    return { input, bound, context, body, source, captured: actualCapture, query, firstDecisionMs }
  })

test('the pair extracts the same causal features and uses the actual training mean', async () => {
  const data = await Effect.runPromise(fixture({ mean: 0, intercept: 5 }))
  const cursor = replaySixBarFixture(data.captured, firstDecisionMs)
  const ridge = Result.getOrThrow(selectBoundRidge(cursor, data.query, data.bound, RidgeControlPolicy.Ridge))
  const baseline = Result.getOrThrow(selectBoundRidge(cursor, data.query, data.bound, RidgeControlPolicy.TrainingMean))
  expect(ridge.status).toBe('AVAILABLE')
  expect(baseline.status).toBe('AVAILABLE')
  if (ridge.status !== 'AVAILABLE' || baseline.status !== 'AVAILABLE')
    throw new Error('Expected available synthetic decisions')
  expect(ridge.evidence.selectedSymbol).toBe('AAPL')
  expect(baseline.evidence.selectedSymbol).toBeNull()
  expect(baseline.evidence.scores).toEqual(protocol.candidateSymbols.map((symbol) => ({ symbol, scoreBps: 0 })))
  expect(ridge.evidence.observations).toEqual(baseline.evidence.observations)
  expect(
    ridge.evidence.observations.every(
      (observation) => observation.query.calendar.normalizedResponseHash === calendar.normalizedResponseHash,
    ),
  ).toBeTrue()
  expect(calendar.normalizedResponseHash).not.toBe(executionCalendar.normalizedResponseHash)
})

test.each([0, -5])('a %d-bps constant does not mask unavailable candidate inputs', async (mean) => {
  const data = await Effect.runPromise(fixture({ missing: true, mean }))
  const decision = Result.getOrThrow(
    selectBoundRidge(
      replaySixBarFixture(data.captured, firstDecisionMs),
      data.query,
      data.bound,
      RidgeControlPolicy.TrainingMean,
    ),
  )
  expect(decision.status).toBe('UNAVAILABLE')
})

test('evidenced exclusions retain an available cash decision with empty admissible candidates', async () => {
  const data = await Effect.runPromise(fixture({ exclude: true }))
  for (const policy of [RidgeControlPolicy.Ridge, RidgeControlPolicy.TrainingMean]) {
    const decision = Result.getOrThrow(
      selectBoundRidge(replaySixBarFixture(data.captured, firstDecisionMs), data.query, data.bound, policy),
    )
    expect(decision.status).toBe('AVAILABLE')
    if (decision.status !== 'AVAILABLE') throw new Error('Expected evidenced exclusions')
    expect(decision.evidence.selectedSymbol).toBeNull()
    expect(decision.evidence.scores).toEqual([])
    expect(decision.evidence.observations.map((observation) => observation.status)).toEqual(
      protocol.candidateSymbols.map(() => SixBarResearchStatus.Excluded),
    )
  }
})

test('artifact, source, calendar, partition, label and actual successor mismatches reject', async () => {
  const data = await Effect.runPromise(fixture())
  const rehash = (artifact: typeof data.input.artifact) => {
    const { artifactHash: _, ...payload } = artifact
    return { ...payload, artifactHash: hash(payload) }
  }
  for (const input of [
    { ...data.input, expectedArtifact: { ...data.input.expectedArtifact, artifactHash: 'f'.repeat(64) } },
    { ...data.input, expectedArtifact: { ...data.input.expectedArtifact, manifestHash: 'f'.repeat(64) } },
    { ...data.input, expectedArtifact: { ...data.input.expectedArtifact, sourceRevision: 'f'.repeat(40) } },
    { ...data.input, evaluationSourceManifestHash: 'f'.repeat(64) },
    { ...data.input, expectedCalendarHash: 'f'.repeat(64) },
    { ...data.input, partition: SixBarRidgePartition.Holdout },
    { ...data.input, artifact: { ...data.input.artifact, schemaVersion: 'bayn.six-bar-ridge-artifact.v1' } },
  ])
    expect(Result.isFailure(prepareBoundRidge(input, data.context))).toBeTrue()
  for (const artifact of [
    rehash({ ...data.input.artifact, allocationBudgetMicros: '10000000000' }),
    rehash({
      ...data.input.artifact,
      provenance: { ...data.input.artifact.provenance, labelDefinitionHash: 'f'.repeat(64) },
    }),
  ])
    expect(
      Result.isFailure(
        prepareBoundRidge(
          {
            ...data.input,
            artifact,
            expectedArtifact: { ...data.input.expectedArtifact, artifactHash: artifact.artifactHash },
          },
          data.context,
        ),
      ),
    ).toBeTrue()
  const wrongSuccessor = Result.getOrThrow(
    normalizeMarketCalendarResult([fullCalendar[1]!, fullCalendar[3]!], { start: '2026-09-04', end: '2026-09-09' }),
  )
  expect(Result.isFailure(prepareBoundRidge(data.input, { ...data.context, calendar: wrongSuccessor }))).toBeTrue()
  expect(
    Result.isFailure(
      prepareBoundRidge(data.input, { ...data.context, sessions: [{ ...session, date: '2026-09-08' }] }),
    ),
  ).toBeTrue()
  const cursor = replaySixBarFixture(data.captured, firstDecisionMs)
  for (const observedAt of ['2026-09-04T14:00:00.000Z', session.closeAt])
    expect(
      Result.isFailure(
        selectBoundRidge(cursor, { ...data.query, observedAt }, data.bound, RidgeControlPolicy.TrainingMean),
      ),
    ).toBeTrue()
  expect(
    Result.isFailure(
      selectBoundRidge(cursor, { ...data.query, candidateSymbols: [] }, data.bound, RidgeControlPolicy.Ridge),
    ),
  ).toBeTrue()
})

test.each(['cash', 'filled'] as const)(
  'the actual %s frozen-source runner produces both policies without a provider or journal',
  async (mode) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const data = yield* fixture(mode === 'cash' ? { mean: 0, intercept: 0 } : { exitQuotes: true })
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const arrivals = `${directory}/arrivals.ndjson.gz`
        yield* fs.writeFile(arrivals, data.body)
        const { verification: _verification, ...build } = config.build
        const receiptText = JSON.stringify({
          schemaVersion: 'bayn.original-capture-replay-receipt.v1',
          recordedAt: iso(data.source.coverageEndMs + 1),
          origin: data.source.origin,
          coverageStartMs: data.source.coverageStartMs,
          coverageEndMs: data.source.coverageEndMs,
          universe: data.source.universe,
          positions: data.source.positions,
          nativeVisiblePartitions: data.source.nativeVisiblePartitions,
          deliveryModel: data.source.deliveryModel,
          sourceDataSha256: data.source.dataSha256,
        })
        const receipt = yield* Effect.fromResult(validateBacktestSourceReceipt(receiptText, sha256(receiptText)))
        const input = {
          schemaVersion: 'bayn.control-study-input.v6',
          management: ControlManagementMode.Mechanical,
          decisionLatencyMs: 1000,
          turnoverPolicy: data.context.turnoverPolicy,
          ridge: data.input,
          backtest: {
            schemaVersion: 'bayn.backtest.v3',
            source: data.source,
            openingCashMicros: '100000000000',
            fractionalTrading: false,
            inference: {
              mode: 'measured-provider',
              model: jevModel,
              inputDefinition: 'bayn.jev-trading-signal-state.v2',
              costs: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
            },
            allocatedDataCostPerSessionMicros: '1000000',
            replicate: 'SYNTHETIC ridge pair',
            sessionDates: ['2026-09-04'],
            calendar: fullCalendar.slice(1, 3),
            build,
            assumptions,
            assets: protocol.universe.map((symbol, index) => ({
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
            cadence: {
              pollIntervalMs: 30000,
              reconciliationIntervalMs: 30000,
              reconciliationPassTimeoutMs: 30000,
              reconciliationStaleThresholdMs: 120000,
            },
          },
        }
        const report = yield* runControlStudy(input, arrivals, receipt, { mode: ControlManagementMode.Mechanical })
        expect(report.schemaVersion).toBe('bayn.control-study-report.v5')
        expect(report.sessions.map((result) => result.policy)).toEqual([
          ControlPolicy.Ridge,
          ControlPolicy.TrainingMean,
        ])
        for (const result of report.sessions) {
          expect(result.modelCallCount).toBe(0)
          if (mode === 'cash') {
            expect(result.ledger.fills).toHaveLength(0)
            expect(result.netPnlAfterKnownCostsMicros).toBe('-1000000')
            expect(result.completion).toBe('INCOMPLETE')
          } else {
            expect(result.completion).toBe('COMPLETE')
            expect(result.completedEpisodes).toBe(1)
            expect(result.ledger.positions).toHaveLength(0)
            expect(
              result.ledger.fills.map(({ quantityMicros, priceMicros, notionalMicros }) => ({
                quantityMicros,
                priceMicros,
                notionalMicros,
              })),
            ).toEqual([
              { quantityMicros: '100000000', priceMicros: '105030000', notionalMicros: '10503000000' },
              { quantityMicros: '25000000', priceMicros: '104970000', notionalMicros: '2624250000' },
              { quantityMicros: '25000000', priceMicros: '104970000', notionalMicros: '2624250000' },
              { quantityMicros: '25000000', priceMicros: '104970000', notionalMicros: '2624250000' },
              { quantityMicros: '25000000', priceMicros: '104970000', notionalMicros: '2624250000' },
            ])
            expect(result.executionFeesMicros).toBe('250000')
            expect(result.closingCapital.cashMicros).toBe('99993750000')
            expect(result.filledNotionalMicros).toBe('21000000000')
            expect(result.netPnlAfterKnownCostsMicros).toBe('-7250000')
          }
          expect(result.simulatedOpportunityAccounting?.accountedPollCount).toBe(80)
          expect(result).toMatchObject({
            sizing: { mode: 'FIXED_PRINCIPAL_BUDGET', allocationBudgetMicros: '20000000000' },
          })
          expect(result).not.toHaveProperty('targetWeight')
        }
        expect(yield* fs.readDirectory(directory)).toEqual(['arrivals.ndjson.gz'])
        expect(Result.isFailure(yield* Effect.result(runControlPreflight(input, arrivals, receipt)))).toBeTrue()
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
    )
  },
)

const simulate = (
  options: {
    canceled?: boolean
    missingFirst?: boolean
    mean?: number
    exclude?: boolean
    policy?: ControlPolicy.Ridge | ControlPolicy.TrainingMean
  } = {},
) =>
  Effect.gen(function* () {
    const data = yield* fixture({
      pollIntervalMs: options.missingFirst === true ? 1000 : 30000,
      mean: options.mean ?? 5,
      exclude: options.exclude ?? false,
    })
    let now = sixBarOpenMs
    const selectedAt: number[] = []
    const cursor = replaySixBarFixture(data.captured, data.firstDecisionMs)
    const market: ControlMarket = {
      advanceTo: (atMs) =>
        Effect.sync(() => {
          expect(atMs).toBeGreaterThanOrEqual(now)
          now = atMs
        }),
      snapshot: () => Effect.die('The mechanical Ridge pair must not call native snapshots or model management'),
      quoteAt: (symbol, atMs) =>
        Effect.sync(() => {
          const quote = observedQuoteAt(cursor.projection, symbol, data.firstDecisionMs)
          if (quote === undefined) return undefined
          const value = {
            ...quote.value,
            eventAt: iso(atMs),
            ingestedAt: iso(atMs),
            askSize: options.canceled === true ? 0 : 100,
            bidSize: 25,
          }
          return { value, availableAtMs: atMs, sequence: 1, recordHash: hash(value) }
        }),
    }
    const result = yield* runControlSession({
      policy: options.policy ?? ControlPolicy.TrainingMean,
      protocol,
      risk: data.context.risk,
      session,
      calendar: executionCalendar,
      openingCapital: {
        cashMicros: '100000000000',
        peakBrokerEquityMicros: '100000000000',
        peakNetEquityMicros: '100000000000',
        accruedExternalCostMicros: '0',
      },
      dataCostMicros: '1000000',
      targetWeight: 1,
      decisionLatencyMs: 1000,
      pollIntervalMs: data.context.pollIntervalMs,
      turnoverPolicy: data.context.turnoverPolicy,
      accountScheduledOpportunities: true,
      assumptions,
      eligibleSymbols: new Set(protocol.candidateSymbols),
      market,
      management: null,
      ridge: {
        bound: data.bound,
        select: (query) => {
          selectedAt.push(Date.parse(query.observedAt))
          const cutAt =
            options.missingFirst === true && selectedAt.length === 1
              ? data.firstDecisionMs - 2000
              : Date.parse(query.observedAt)
          return Effect.fromResult(
            selectBoundRidge(
              replaySixBarFixture(data.captured, cutAt),
              query,
              data.bound,
              options.policy === ControlPolicy.Ridge ? RidgeControlPolicy.Ridge : RidgeControlPolicy.TrainingMean,
            ),
          ).pipe(Effect.mapError((cause) => new ControlStudyFailure({ message: 'Synthetic selection failed', cause })))
        },
      },
    })
    return { result, selectedAt, data }
  })

test.each([ControlPolicy.Ridge, ControlPolicy.TrainingMean])(
  '%s uses one real position and persistent partial exits with finite quote liquidity',
  async (policy) => {
    const { result } = await Effect.runPromise(simulate({ policy }))
    expect(result.ledger.fills.map((fill) => fill.quantityMicros)).toEqual([
      '100000000',
      '25000000',
      '25000000',
      '25000000',
      '25000000',
    ])
    expect(result.completedEpisodes).toBe(1)
    expect(result.ledger.positions).toHaveLength(0)
    expect(result.orders.filter((order) => order.side === OrderSide.Buy)).toHaveLength(1)
    expect(result.modelCallCount).toBe(0)
    expect(result.unpricedModelCallCount).toBe(0)
    expect(result.simulatedOpportunityAccounting?.accountedPollCount).toBe(80)
    expect(result.executionFeesMicros).toBe('250000')
    expect(result.closingCapital.cashMicros).toBe('99993750000')
    expect(result.netPnlAfterKnownCostsMicros).toBe('-7250000')
  },
)

test('canceled entries and cash retain opportunities and their allocated data charge', async () => {
  for (const options of [{ canceled: true }, { mean: 0 }]) {
    const { result } = await Effect.runPromise(simulate(options))
    expect(result.ledger.fills).toHaveLength(0)
    expect(result.completedEpisodes).toBe(0)
    expect(result.netPnlAfterKnownCostsMicros).toBe('-1000000')
    expect(result.modelCostMicros).toBe('0')
    expect(result.simulatedOpportunityAccounting?.accountedPollCount).toBe(80)
    expect(result.issues).toContain('MISSING_DECISION_DATA')
    if ('canceled' in options) expect(result.orders).toHaveLength(1)
  }
})

test('missing input leaves the same minute window available for a later causal poll', async () => {
  const { result, selectedAt, data } = await Effect.runPromise(simulate({ missingFirst: true }))
  expect(selectedAt.slice(0, 2)).toEqual([data.firstDecisionMs, data.firstDecisionMs + 1000])
  expect(result.decisions.slice(0, 2).map((decision) => decision.status)).toEqual(['UNAVAILABLE', 'SELECTED'])
  expect(result.missingDecisions).toBe(1)
  expect(result.completion).toBe('INCOMPLETE')
  expect(result.completedEpisodes).toBe(1)
  expect(result.simulatedOpportunityAccounting?.accountedPollCount).toBe(2400)
})

test.each([ControlPolicy.Ridge, ControlPolicy.TrainingMean])(
  '%s reports evidenced exclusions in decisions and opportunity counters',
  async (policy) => {
    const { result } = await Effect.runPromise(simulate({ policy, exclude: true }))
    expect(result.decisions[0]?.status).toBe('NO_SIGNAL')
    expect(result.decisions[0]?.exclusions?.map((entry) => entry.symbol)).toEqual([...protocol.candidateSymbols])
    expect(
      result.decisions[0]?.exclusions?.every(
        (entry) => 'inputSymbol' in entry && entry.inputSymbol === entry.symbol && entry.evidenceHash.length === 64,
      ),
    ).toBeTrue()
    expect(result.simulatedOpportunityAccounting).toMatchObject({
      entrySnapshotsWithCandidateExclusions: 1,
      excludedCandidateObservationCount: protocol.candidateSymbols.length,
    })
    expect(result.ledger.fills).toHaveLength(0)
    expect(result.dataCostMicros).toBe('1000000')
  },
)

test.each([RidgeControlPolicy.Ridge, RidgeControlPolicy.TrainingMean])(
  '%s requires the original complete extraction pins after row projection',
  async (policy) => {
    const data = await Effect.runPromise(fixture())
    const decision = Result.getOrThrow(
      selectBoundRidge(replaySixBarFixture(data.captured, firstDecisionMs), data.query, data.bound, policy),
    )
    if (decision.status !== 'AVAILABLE') throw new Error('Expected verified fixture observations')
    const pins = [...decision.evidence.requiredFeatureRowHashes]
    const rows = decision.evidence.observations.flatMap((observation) =>
      observation.status === SixBarResearchStatus.Available
        ? [
            {
              sessionDate: observation.query.sessionDate,
              symbol: observation.candidateSymbol,
              featureDefinitionHash: observation.definitionHash,
              featureEvidenceHash: observation.evidenceHash,
              sourceManifestHash: observation.source.sourceManifestHash,
              calendarHash: observation.query.calendar.normalizedResponseHash,
              availableAt: iso(Math.max(...observation.receipts.map((receipt) => receipt.availableAtMs))),
              decisionAt: observation.query.observedAt,
              values: observation.values,
            },
          ]
        : [],
    )
    expect(Result.isSuccess(scorePinnedRidgeCandidates(data.bound, data.query, rows, pins, policy))).toBeTrue()
    const changed = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            values: [
              row.values[0] + 1,
              row.values[1],
              row.values[2],
              row.values[3],
              row.values[4],
              row.values[5],
              row.values[6],
            ] as const,
          }
        : row,
    )
    for (const candidates of [changed, rows.slice(1), [...rows, rows[0]!]])
      expect(Result.isFailure(scorePinnedRidgeCandidates(data.bound, data.query, candidates, pins, policy))).toBeTrue()
    expect(decision.evidence.requiredFeatureRowHashes).toEqual(pins)
    expect(Result.isFailure(scorePinnedRidgeCandidates(data.bound, data.query, rows, [], policy))).toBeTrue()
  },
)

test('the constant validates source and content without depending on Ridge normalization arithmetic', async () => {
  const data = await Effect.runPromise(fixture())
  const { artifactHash: _, ...payload } = data.input.artifact
  const changed = { ...payload, scales: [Number.MIN_VALUE, 0, 0, 0, 0, 0, 0], coefficients: [1, 0, 0, 0, 0, 0, 0] }
  const artifact = { ...changed, artifactHash: hash(changed) }
  const bound = Result.getOrThrow(
    prepareBoundRidge(
      {
        ...data.input,
        artifact,
        expectedArtifact: { ...data.input.expectedArtifact, artifactHash: artifact.artifactHash },
      },
      data.context,
    ),
  )
  const cursor = replaySixBarFixture(data.captured, firstDecisionMs)
  expect(Result.isFailure(selectBoundRidge(cursor, data.query, bound, RidgeControlPolicy.Ridge))).toBeTrue()
  const baseline = Result.getOrThrow(selectBoundRidge(cursor, data.query, bound, RidgeControlPolicy.TrainingMean))
  expect(baseline.status).toBe('AVAILABLE')
  if (baseline.status !== 'AVAILABLE') throw new Error('Expected available constant scores')
  expect(baseline.evidence.scores).toEqual(protocol.candidateSymbols.map((symbol) => ({ symbol, scoreBps: 5 })))
})
