import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { BrokerMode, executionRiskPolicySchemaVersion } from '../risk'
import { OrderType, TimeInForce } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import {
  nativeJevDecisionEvidence,
  nativeJevFixture,
  jevObservationForSnapshot,
  nativeJevBatchResult,
} from '../jev/native.test-support'
import { JevBatchPlanVersion } from '../jev/batch'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { replayTestInstruments } from '../testing/replay-instruments'
import type { IntradayQuote } from '../market-data/intraday/model'
import { prepareSignalStudyBatch } from './signal-study'
import {
  capitalEvents,
  capitalNetDifference,
  CapitalArm,
  CapitalAdmission,
  CapitalEventKind,
  CapitalTermsSchema,
  createCapitalState,
  finishCapitalState,
  markCapitalState,
  stepCapitalState,
  validateCapitalPopulation,
  type CapitalOpportunity,
  type CapitalTerms,
  type CapitalScenario,
} from './capital-ablation'
import { Schema } from 'effect'

const fixture = nativeJevFixture()
const original = fixture.snapshot.latestQuotes['AAPL']
if (original === undefined) throw new Error('Missing native quote')
const baseAt = Date.parse(fixture.observation.payload.observedAt) + 100
const scenario: CapitalScenario = {
  id: 'base',
  latencyMs: 100,
  slippageBps: 0,
  availableLiquidityPpm: 1_000_000,
  feeMultiplierPpm: 1_000_000,
}
const terms: CapitalTerms = Schema.decodeUnknownSync(CapitalTermsSchema)({
  openingCashMicros: '100000000000',
  policy: {
    schemaVersion: executionRiskPolicySchemaVersion,
    accountId: 'jev-native-test',
    brokerMode: BrokerMode.Execution,
    allowedSymbols: ['AAPL', 'AMZN', 'BTC/USD', 'ETH/USD', 'SOL/USD'],
    allowedOrderTypes: [OrderType.Limit],
    allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
    maxOrderNotionalMicros: '40000000000',
    maxSymbolExposureMicros: '40000000000',
    maxGrossExposureMicros: '100000000000',
    maxNetExposureMicros: '100000000000',
    maxDailyTradedNotionalMicros: '200000000000',
    maxDailyLossMicros: '5000000000',
    maxDrawdownMicros: '5000000000',
    maxIntentAgeMs: 300000,
    maxBrokerStateAgeMs: 300000,
    maxMarketDataAgeMs: 300000,
    maxAdverseSlippageBps: 10,
    maxOpenOrders: 5,
    decisionTtlMs: 300000,
  },
  instruments: replayTestInstruments,
  costHurdleMarginBps: 0,
  scenarios: [scenario],
})
const opportunity = (offsetMs = 0, action = 'enter', probability = 0.8): CapitalOpportunity => {
  const native = nativeJevFixture(undefined, new Date(baseAt - 100 + offsetMs).toISOString())
  const { decidedAt, ...evidence } = nativeJevDecisionEvidence(native, action, probability)
  return {
    batch: Result.getOrThrow(prepareSignalStudyBatch(evidence)),
    committedAtMs: Date.parse(decidedAt),
    inferenceCostMicros: '10000',
    operatingCostMicros: '1000',
    knownInferenceCostMicros: '10000',
    knownOperatingCostMicros: '1000',
  }
}
const cryptoOpportunity = (symbol: 'BTC/USD' | 'ETH/USD' | 'SOL/USD'): CapitalOpportunity => {
  const { snapshot } = cryptoMarketFixture(symbol, { observedPriceChoices: true })
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observation.observedAt) + 10_000).toISOString(),
      planVersion: JevBatchPlanVersion.V6,
    }),
  )
  const completedAt = new Date(Date.parse(observation.observedAt) + 100).toISOString()
  const batchResult = nativeJevBatchResult(batchPlan, completedAt)
  return {
    batch: Result.getOrThrow(prepareSignalStudyBatch({ observation, batchPlan, batchResult })),
    committedAtMs: Date.parse(completedAt),
    inferenceCostMicros: '10000',
    operatingCostMicros: '1000',
    knownInferenceCostMicros: '10000',
    knownOperatingCostMicros: '1000',
  }
}
const quoteAt = (symbol: string, atMs: number, overrides: Partial<IntradayQuote> = {}) => {
  const crypto = symbol.includes('/')
  const value: IntradayQuote = {
    ...original,
    symbol,
    feed: crypto ? 'us' : 'iex',
    delayClass: crypto ? 'real_time_crypto' : 'real_time_exchange_only',
    marketSession: crypto ? 'continuous' : 'regular',
    eventAt: new Date(atMs).toISOString(),
    ingestedAt: new Date(atMs).toISOString(),
    bidPrice: 100,
    askPrice: 100.02,
    bidSize: 1000,
    askSize: 1000,
    ...overrides,
  }
  return { value, availableAtMs: atMs, sequence: 1, recordHash: Result.getOrThrow(canonicalHashV1Result(value)) }
}
const evaluate = (
  opps: readonly CapitalOpportunity[],
  chosen = scenario,
  config = terms,
  quote: (symbol: string, atMs: number) => ReturnType<typeof quoteAt> | undefined = quoteAt,
) => {
  Result.getOrThrow(validateCapitalPopulation(opps, config))
  const states = Object.values(CapitalArm).map((arm) =>
    Result.getOrThrow(createCapitalState(arm, config.openingCashMicros)),
  )
  const end = Math.max(...opps.map((o) => o.committedAtMs ?? Date.parse(o.batch.decidedAt))) + 19 * 60_000
  for (const event of capitalEvents(opps, chosen, end)) {
    for (let index = 0; index < states.length; index++) {
      const state = states[index]
      if (state === undefined) throw new Error('Missing arm')
      const symbol =
        event.kind === CapitalEventKind.Opportunity ? event.opportunity.batch.selected.JEV : state.active?.terms.symbol
      const result = stepCapitalState(
        state,
        config,
        chosen,
        event,
        symbol == null ? undefined : quote(symbol, event.atMs),
        state.portfolio.ledger.positions[0] === undefined
          ? undefined
          : quote(state.portfolio.ledger.positions[0].symbol, event.atMs),
      )
      if (Result.isFailure(result)) throw new Error(JSON.stringify(result.failure))
      const stepped = result.success
      const held = stepped.portfolio.ledger.positions[0]?.symbol
      states[index] = Result.getOrThrow(
        markCapitalState(stepped, event.atMs, held === undefined ? undefined : quote(held, event.atMs)),
      )
    }
  }
  return states.map(finishCapitalState)
}

test('both arms retain every identical current native opportunity, abstention and capital overlap', () => {
  const opps = [opportunity(60_000), opportunity(), opportunity(120_000, 'wait')]
  const reports = evaluate(opps)
  expect(reports[0]?.eligibleOpportunityIds).toEqual(reports[1]?.eligibleOpportunityIds)
  expect(reports[0]?.metrics).toMatchObject({
    opportunities: 3,
    admitted: 1,
    capitalBusy: 1,
    entryOrders: 1,
    filledEntries: 1,
    closedEpisodes: 1,
    executionComplete: true,
  })
  expect(reports[0]?.opportunities.map((row) => String(row.status))).toEqual([
    CapitalAdmission.Admitted,
    CapitalAdmission.CapitalBusy,
    CapitalAdmission.Abstain,
  ])
  expect(reports[0]?.metrics.knownInferenceCostMicros).toBe('30000')
  expect(reports[0]?.ledger.positions).toEqual([])
  expect(reports[0]?.trades[0]?.result.requestedEntryQuantityAtoms).toBe('199000000000')
  expect(Result.getOrThrow(validateCapitalPopulation(opps, terms))).toBe(
    Result.getOrThrow(canonicalHashV1Result(defaultJevProtocolDocument)),
  )
  expect(evaluate(opps)).toEqual(reports)
})

test('cost hurdle rejects an expensive low-proxy opportunity while preserving both population and spending', () => {
  const opp = opportunity()
  const expensive = { ...opp, inferenceCostMicros: '1000000000', knownInferenceCostMicros: '1000000000' }
  const [baseline, candidate] = evaluate([expensive])
  expect(baseline?.metrics.filledEntries).toBe(1)
  expect(candidate?.metrics).toMatchObject({
    opportunities: 1,
    costRejected: 1,
    filledEntries: 0,
    turnoverMicros: '0',
    netAfterAllCostsMicros: '-1000001000',
  })
  expect(baseline?.eligibleOpportunityIds).toEqual(candidate?.eligibleOpportunityIds)
  expect(baseline?.metrics.knownInferenceCostMicros).toBe(candidate?.metrics.knownInferenceCostMicros)
})

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test(`${symbol} executes the selected complete plan and retains actual losses under fee stress`, () => {
    const opp = cryptoOpportunity(symbol)
    let previousNet: bigint | undefined
    for (const chosen of [scenario, { ...scenario, id: 'double-fees', feeMultiplierPpm: 2_000_000 }]) {
      const base = evaluate([opp], chosen)[0]
      expect(base?.metrics.executionComplete).toBe(true)
      expect(base?.metrics.filledEntries).toBe(1)
      if (base?.metrics.netExecutionPnlMicros === undefined || base.metrics.netExecutionPnlMicros === null)
        throw new Error('Expected complete fee-accounted replay')
      const net = BigInt(base.metrics.netExecutionPnlMicros)
      expect(net).toBeLessThan(0n)
      expect(base.metrics.netAfterAllCostsMicros).toBe((net - 11000n).toString())
      expect(base.ledger.fills.some((fill) => fill.side === 'buy' && fill.symbol === symbol)).toBe(true)
      expect(base.ledger.fills.some((fill) => fill.side === 'sell' && fill.symbol === symbol)).toBe(true)
      expect(base.ledger.positions).toEqual([])
      if (previousNet !== undefined) expect(net).toBeLessThan(previousNet)
      previousNet = net
    }
  })
}

test('partial IOC fills and reducing retries preserve requested sizes and per-trade fill ownership', () => {
  const opps = [opportunity(), opportunity(16 * 60_000)]
  const reports = evaluate(opps, scenario, terms, (symbol, at) => quoteAt(symbol, at, { askSize: 3, bidSize: 1 }))
  expect(reports[0]?.metrics).toMatchObject({
    partialEntries: 2,
    filledEntries: 2,
    closedEpisodes: 2,
    executionComplete: true,
  })
  expect(reports[0]?.trades).toHaveLength(2)
  expect(reports[0]?.trades.map((trade) => trade.result.fills.length)).toEqual([4, 4])
  expect(reports[0]?.trades.every((trade) => trade.result.fills[0]?.side === 'buy')).toBe(true)
  expect(reports[1]?.metrics).toMatchObject({
    filledEntries: 0,
    netExecutionPnlMicros: '0',
    netAfterAllCostsMicros: '-22000',
    executionComplete: true,
  })
})

test('unknown inference and operating costs remain unknown with known partial spend retained', () => {
  const opp = {
    ...opportunity(),
    inferenceCostMicros: null,
    operatingCostMicros: null,
    knownInferenceCostMicros: '1234',
  }
  const reports = evaluate([opp])
  expect(reports[0]?.metrics).toMatchObject({
    unknownInferenceAllocations: 1,
    knownInferenceCostMicros: '1234',
    netAfterInferenceMicros: null,
    netAfterAllCostsMicros: null,
    maximumDrawdownAfterAllCostsMicros: null,
  })
  expect(reports[1]?.opportunities[0]?.status).toBe(CapitalAdmission.UnknownHurdleCost)
})

test('late or missing native commitment retains and charges the opportunity', () => {
  const first = opportunity()
  const late = { ...first, committedAtMs: Date.parse(first.batch.plan.expiresAt) }
  const [report] = evaluate([late, { ...opportunity(60_000), committedAtMs: null }])
  expect(report?.opportunities.map((row) => String(row.status))).toEqual([
    CapitalAdmission.Late,
    CapitalAdmission.UnknownCommitment,
  ])
  expect(report?.metrics).toMatchObject({
    opportunities: 2,
    filledEntries: 0,
    knownInferenceCostMicros: '20000',
    netAfterAllCostsMicros: null,
  })
})

test('turnover reserve and loss gates bind both arms without dropping opportunities or blocking exits', () => {
  const config = { ...terms, policy: { ...terms.policy, maxDailyTradedNotionalMicros: '40000000000' } }
  const [report] = evaluate([opportunity(), opportunity(16 * 60_000)], scenario, config)
  expect(report?.metrics.opportunities).toBe(2)
  expect(BigInt(report?.metrics.turnoverMicros ?? '0')).toBeLessThanOrEqual(40_000_000_000n)
  expect(report?.metrics.closedEpisodes).toBe(1)
  expect(report?.opportunities[1]?.status).toBe(CapitalAdmission.CapitalOrTurnoverBlocked)
  const [loss] = evaluate(
    [opportunity(), opportunity(60_000)],
    scenario,
    { ...terms, policy: { ...terms.policy, maxDailyLossMicros: '1000000' } },
    (symbol, at) =>
      quoteAt(symbol, at, { bidPrice: at > baseAt + 5000 ? 98 : 100, askPrice: at > baseAt + 5000 ? 98.02 : 100.02 }),
  )
  expect(loss?.opportunities[1]?.status).toBe(CapitalAdmission.LossOrDrawdownBlocked)
  expect(loss?.metrics.maximumDrawdownAfterAllCostsMicros).not.toBe('0')
}, 30_000)

test('retired or changed protocols, duplicate ids and foreign accounts cannot compare', () => {
  const opp = opportunity()
  for (const protocol of [
    { ...defaultJevProtocolDocument, schemaVersion: 'bayn.jev.protocol.v4' },
    { ...defaultJevProtocolDocument, schemaVersion: 'bayn.jev.protocol.v5' },
    { ...defaultJevProtocolDocument, maximumGrossWeight: 0.4 },
  ]) {
    expect(
      Result.isFailure(
        validateCapitalPopulation(
          [
            {
              ...opp,
              batch: {
                ...opp.batch,
                observation: { ...opp.batch.observation, protocol: protocol as typeof defaultJevProtocolDocument },
              },
            },
          ],
          terms,
        ),
      ),
    ).toBe(true)
  }
  expect(Result.isFailure(validateCapitalPopulation([opp, opp], terms))).toBe(true)
  expect(
    Result.isFailure(validateCapitalPopulation([opp], { ...terms, policy: { ...terms.policy, accountId: 'other' } })),
  ).toBe(true)
})

test('current chosen-model-action baseline retains an enter choice below the retired probability floor', () => {
  const opp = opportunity(0, 'enter', 0.6)
  const [baseline, candidate] = evaluate([opp])
  expect(defaultJevProtocolDocument.schemaVersion).toBe('bayn.jev.protocol.v22')
  expect(defaultJevProtocolDocument.entrySelectionPolicy).toBe('supported-setup-and-economic-plan')
  expect(baseline?.metrics.filledEntries).toBe(1)
  expect(baseline?.opportunities[0]?.status).toBe(CapitalAdmission.Admitted)
  expect(baseline?.eligibleOpportunityIds).toEqual(candidate?.eligibleOpportunityIds)
})

test('post-coverage commitment stays in both populations and cost totals', () => {
  const opp = opportunity()
  const at = opp.committedAtMs ?? 0
  const event = capitalEvents([opp], scenario, at - 1)[0]
  if (event === undefined) throw new Error('Dropped opportunity')
  for (const arm of Object.values(CapitalArm)) {
    const state = Result.getOrThrow(
      stepCapitalState(
        Result.getOrThrow(createCapitalState(arm, terms.openingCashMicros)),
        terms,
        scenario,
        event,
        undefined,
      ),
    )
    const report = finishCapitalState(state)
    expect(report.opportunities).toHaveLength(1)
    expect(report.opportunities[0]?.status).toBe(CapitalAdmission.UnknownCommitmentOutsideSource)
    expect(report.metrics.knownInferenceCostMicros).toBe('10000')
    expect(report.metrics.netAfterAllCostsMicros).toBeNull()
  }
})

test('commitment repricing rechecks native market spread and positive displayed sides', () => {
  for (const overrides of [{ askPrice: 101 }, { askSize: 0 }, { bidSize: 0 }]) {
    const reports = evaluate([opportunity()], scenario, terms, (symbol, at) => quoteAt(symbol, at, overrides))
    expect(reports.map((arm) => arm.opportunities[0]?.status)).toEqual([
      CapitalAdmission.EntryQuoteBlocked,
      CapitalAdmission.EntryQuoteBlocked,
    ])
    expect(reports.every((arm) => arm.metrics.filledEntries === 0)).toBe(true)
  }
})

test('routing, execution cost and capacity sensitivity reexecute the same population', () => {
  const opp = opportunity()
  const [base] = evaluate([opp])
  const [slipped] = evaluate([opp], { ...scenario, slippageBps: 5 })
  const [partial] = evaluate([opp], { ...scenario, availableLiquidityPpm: 10_000 }, terms, (symbol, at) =>
    quoteAt(symbol, at, { bidSize: 100, askSize: 100 }),
  )
  const [late] = evaluate([opp], { ...scenario, latencyMs: 1000 }, terms, (symbol, at) =>
    quoteAt(symbol, at, {
      bidPrice: at === baseAt + 1000 ? 101 : 100,
      askPrice: at === baseAt + 1000 ? 101.02 : 100.02,
    }),
  )
  expect(slipped?.eligibleOpportunityIds).toEqual(base?.eligibleOpportunityIds)
  expect(BigInt(slipped?.metrics.netExecutionPnlMicros ?? '0')).toBeLessThan(
    BigInt(base?.metrics.netExecutionPnlMicros ?? '0'),
  )
  expect(partial?.metrics.partialEntries).toBe(1)
  expect(late?.metrics.filledEntries).toBe(0)
  expect(late?.metrics.entryOrders).toBe(1)
})

test('verified equity and crypto archive cursors carry one cash ledger across market calendars', async () => {
  const { Effect, FileSystem } = await import('effect')
  const { NodeServices } = await import('@effect/platform-node')
  const { gzipSync } = await import('node:zlib')
  const { normalizeMarketCalendarResult } = await import('../broker/alpaca/normalizers')
  const { streamingFixtureFromRaw, streamingFixture } = await import('../testing/streaming-market-fixture')
  const { makeJevMarketTestSnapshot: makeIntradayMomentumTestSnapshot } = await import('../testing/jev-market-fixture')
  const { equityMarketProfile, cryptoMarketProfile } = await import('../jev/markets')
  const { historicalRawArrivals } = await import('../testing/historical-streaming-fixture')
  const { sha256 } = await import('../hash')
  const { backtestSourcePartitions, openBacktestSource } = await import('./source')
  const { retainedReplayCaptureFixture } = await import('../testing/retained-replay-fixture')
  const { replayCapitalSources } = await import('./capital-study')
  const crypto = cryptoOpportunity('BTC/USD')
  const at = crypto.committedAtMs ?? 0
  // The Monday equity fixture follows Sunday crypto; both source cursors must carry the same cash ledger.
  const equityAt = Date.parse('2026-10-12T14:01:03.100Z')
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ session_open: '0930', session_close: '1600', date: '2026-10-12', open: '09:30', close: '16:00' }],
      {
        start: '2026-10-12',
        end: '2026-10-12',
      },
    ),
  )
  const query = {
    ...fixture.query,
    calendar,
    sessionDate: '2026-10-12' as const,
    observedAt: new Date(equityAt - 100).toISOString(),
    rangeStartAt: '2026-10-12T13:31:00.000Z',
    rangeEndAt: '2026-10-12T14:01:00.000Z',
  }
  const equitySnapshot = streamingFixtureFromRaw(
    makeIntradayMomentumTestSnapshot(
      fixture.protocol,
      { ...query, archiveWatermarks: streamingFixture().archive.manifest.archiveWatermarks },
      { AAPL: 0.02 },
    ),
    query,
  ).snapshot
  const observation = Result.getOrThrow(jevObservationForSnapshot(equitySnapshot)).payload
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(equityAt + 9900).toISOString(),
      planVersion: JevBatchPlanVersion.V6,
    }),
  )
  const batchResult = nativeJevBatchResult(batchPlan, new Date(equityAt).toISOString())
  const equity: CapitalOpportunity = {
    ...crypto,
    batch: Result.getOrThrow(prepareSignalStudyBatch({ observation, batchPlan, batchResult })),
    committedAtMs: equityAt,
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const datasets = []
      for (const [index, profile] of [cryptoMarketProfile, equityMarketProfile].entries()) {
        const events = []
        const sourceAt = index === 0 ? at : equityAt
        let offset = 0
        for (let time = sourceAt; time <= sourceAt + 19 * 60_000; time += 5000) {
          for (const symbol of profile.universe) {
            const quote = quoteAt(symbol, time).value
            events.push(
              ...historicalRawArrivals(
                {
                  bars: [],
                  trades: [],
                  quotes: [
                    {
                      ...quote,
                      sourceTopic: profile.sourceTopics.quotes,
                      sourcePartition: 0,
                      sourceOffset: String(offset++),
                    },
                  ],
                },
                time,
              ),
            )
          }
        }
        const bytes = gzipSync(
          events
            .map((event) =>
              JSON.stringify(
                profile === cryptoMarketProfile
                  ? {
                      ...event,
                      record: {
                        ...event.record,
                        value: JSON.stringify({
                          ...JSON.parse(event.record.value),
                          seq: Number(event.record.offset) + 1,
                          payload: {
                            ...JSON.parse(event.record.value).payload,
                            T: 'q',
                            S: JSON.parse(event.record.value).symbol,
                          },
                        }),
                      },
                    }
                  : event,
              ),
            )
            .join('\n') + '\n',
        )
        const path = `${directory}/${index}.ndjson.gz`
        yield* fs.writeFile(path, bytes)
        const base = {
          schemaVersion: 'bayn.backtest-source.v2' as const,
          encoding: 'ndjson-gzip' as const,
          transport: 'captured-kafka' as const,
          origin: 'Synthetic disjoint market cursor integration fixture',
          dataSha256: sha256(bytes),
          recordCount: events.length,
          coverageStartMs: sourceAt,
          coverageEndMs: sourceAt + 19 * 60_000,
          firstAvailableAtMs: sourceAt,
          lastAvailableAtMs: sourceAt + 19 * 60_000,
          positions: [
            { topic: profile.sourceTopics.quotes, partition: 0, startOffset: '0', endOffsetExclusive: String(offset) },
          ],
          marketSources: [
            {
              universeId: profile.universeId,
              universeSymbolHash: profile.universeSymbolHash,
              symbols: profile.universe,
              topics: { ...profile.sourceTopics, features: profile.streamingInput.featureTopic },
            },
          ] as const,
          deliveryModel: {
            schemaVersion: 'bayn.supplied-arrival-times.v1' as const,
            description: 'Synthetic source integration',
            tieBreak: 'availability-topic-partition-offset' as const,
          },
        }
        const manifest = {
          ...base,
          positions: backtestSourcePartitions(base).map(
            ({ topic, partition }) =>
              base.positions.find((position) => position.topic === topic && position.partition === partition) ?? {
                topic,
                partition,
                startOffset: '0',
                endOffsetExclusive: '0',
              },
          ),
        }
        const source = yield* openBacktestSource(
          path,
          manifest,
          String(index + 1).repeat(64),
          retainedReplayCaptureFixture(manifest),
        )
        datasets.push({ manifest, source, opportunities: [index === 0 ? crypto : equity] })
      }
      const replayed = yield* replayCapitalSources(terms, datasets)
      const reports = replayed.contexts.flatMap((context) => [...context.states.values()].map(finishCapitalState))
      if (reports[0]?.metrics.executionComplete === false) expect(reports).toHaveLength(2)
      expect(reports[0]?.opportunities.map((row) => String(row.status))).toEqual([
        CapitalAdmission.Admitted,
        CapitalAdmission.Admitted,
      ])
      expect(reports[0]?.eligibleOpportunityIds).toEqual(reports[1]?.eligibleOpportunityIds)
      expect(reports[0]?.ledger.fills.filter((fill) => fill.side === 'buy').map((fill) => fill.symbol)).toEqual([
        'BTC/USD',
        'AAPL',
      ])
      expect(BigInt(reports[0]?.ledger.cashMicros ?? '0') - BigInt(terms.openingCashMicros)).toBe(
        reports[0]?.trades.reduce((sum, trade) => sum + BigInt(trade.result.netExecutionPnlMicros ?? '0'), 0n),
      )
      expect(reports[0]?.metrics).toMatchObject({
        filledEntries: 2,
        closedEpisodes: 2,
        executionComplete: true,
        knownInferenceCostMicros: '20000',
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
}, 60_000)

test('an unrelated missing mark is counted once and withholds the net comparison after both portfolios close', () => {
  const reports = evaluate([opportunity(), opportunity(2000, 'wait')], scenario, terms, (symbol, at) =>
    at === baseAt + 2000 ? undefined : quoteAt(symbol, at),
  )
  expect(reports.every((report) => report.metrics.executionComplete)).toBe(true)
  expect(reports.every((report) => report.metrics.netAfterAllCostsMicros !== null)).toBe(true)
  expect(reports.map((report) => report.metrics.missingMarks)).toEqual([1, 1])
  expect(reports.every((report) => report.metrics.maximumDrawdownAfterAllCostsMicros === null)).toBe(true)
  expect(capitalNetDifference(true, reports)).toBeNull()
  const complete = evaluate([opportunity()])
  expect(capitalNetDifference(true, complete)).toBe('0')
  expect(capitalNetDifference(false, complete)).toBeNull()
})
