import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { OrderSide } from '../execution/contracts'
import { nativeJevFixture } from '../jev/native.test-support'
import { makeJevTradingSignalRequest } from '../jev/trading-signals'
import { featureBarContentHash } from '../market-data/features/contract'
import technicalFixture from '../market-data/features/fixtures/technical-indicators-v1.json'
import { decodeTechnicalMarketFeature, TechnicalReadiness } from '../market-data/features/technical-contract'
import { incorporateMarketRecord } from '../market-data/streaming/projection'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { applyControlOrder, createControlPortfolio } from './control-portfolio'
import {
  createMatchedLifecycle,
  finishMatchedLifecycle,
  MatchedEvent,
  stepMatchedLifecycle,
} from './matched-entry-lifecycle'
import {
  matchedEntryDefinition,
  matchedObservationMaterial,
  MatchedDataRole,
  MatchedRecommendation,
  summarizeMatchedPairs,
  type MatchedRegistration,
} from './matched-entry-study'

// Independently valid snapshots, identical prices, different optional model inputs.
const technicalSnapshots = (ema = '123450000', offset = '0') => {
  const { snapshot, cut, query, protocol } = streamingFixture()
  const rolling = snapshot.manifest.streaming.features.find((entry) => entry.value.material.symbol === 'AAPL')
  const first = snapshot.bars.find((bar) => bar.symbol === 'AAPL')
  const session = snapshot.manifest.calendar.sessions[0]
  if (rolling === undefined || first === undefined || session === undefined) throw new Error('Missing fixture')
  const open = Date.parse(session.openAt)
  const older = Array.from({ length: 30 }, (_, index) => {
    const at = open + index * 60_000
    const bar = {
      ...first,
      eventAt: new Date(at).toISOString(),
      ingestedAt: new Date(at + 61_000).toISOString(),
      sourceOffset: String(10000 + index),
    }
    return {
      eventTimeNanos: String(BigInt(at) * 1_000_000n),
      ingestionTimeNanos: String(BigInt(at + 61_000) * 1_000_000n),
      sourceTopic: bar.sourceTopic,
      sourcePartition: bar.sourcePartition,
      sourceOffset: bar.sourceOffset,
      contentHash: Result.getOrThrow(featureBarContentHash(bar)),
    }
  })
  const material = {
    ...technicalFixture.material,
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    sessionDate: query.sessionDate,
    windowStartMs: open,
    windowEndMs: Date.parse(query.rangeEndAt),
    inputs: [...older, ...rolling.value.material.inputs],
    values: {
      ...technicalFixture.material.values,
      ema12PriceMicros: { status: TechnicalReadiness.Ready, value: ema },
      realizedVolatility60ReturnsPpm: { status: TechnicalReadiness.Warming, value: null },
    },
  }
  const topic = 'torghut.technical-features.v1'
  const feature = Result.getOrThrow(
    decodeTechnicalMarketFeature({
      material,
      featureId: canonicalHashV1(material),
      producerRevision: 'incremental-audit-fixture',
      computedAtMs: Date.parse(query.observedAt),
    }),
  )
  const projection = incorporateMarketRecord(
    { ...cut.projection, technicalTopic: topic },
    { topic, partition: 0, offset, value: JSON.stringify(feature) },
    {
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: protocol.universe,
      topics: { ...protocol.sourceTopics, features: rolling.topic, technicalFeatures: topic },
    },
    Date.parse(query.observedAt),
  )
  const withTechnical = Result.getOrThrow(
    constructStreamingSnapshot(
      {
        projection,
        positions: [...cut.positions, { topic, partition: 0, offset: String(BigInt(offset) + 1n) }].sort((a, b) =>
          a.topic.localeCompare(b.topic),
        ),
        bootstrap: {
          ...cut.bootstrap,
          partitions: [
            ...cut.bootstrap.partitions,
            { topic, partition: 0, logStartOffset: '0', startOffset: '0', endOffset: String(BigInt(offset) + 1n) },
          ].sort((a, b) => a.topic.localeCompare(b.topic)),
        },
      },
      query,
    ),
  )
  return { withoutTechnical: snapshot, withTechnical }
}

test('matched reproduction distinguishes technical input presence that changes the actual Jev request', () => {
  const { withTechnical, withoutTechnical } = technicalSnapshots()
  const actual = Result.getOrThrow(makeJevTradingSignalRequest(withTechnical, 'AAPL', 'SPY'))
  const missing = Result.getOrThrow(makeJevTradingSignalRequest(withoutTechnical, 'AAPL', 'SPY'))
  expect(actual.requestHash).not.toBe(missing.requestHash)
  expect(canonicalHashV1(matchedObservationMaterial(withTechnical))).not.toBe(
    canonicalHashV1(matchedObservationMaterial(withoutTechnical)),
  )
})

test('matched reproduction binds changed technical values and their exact source coordinates', () => {
  const original = technicalSnapshots().withTechnical
  const differentValue = technicalSnapshots('99900000').withTechnical
  const differentSource = technicalSnapshots('123450000', '1').withTechnical
  const request = (snapshot: typeof original) =>
    Result.getOrThrow(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY')).requestHash
  expect(request(original)).not.toBe(request(differentValue))
  expect(request(original)).toBe(request(differentSource))
  for (const changed of [differentValue, differentSource])
    expect(canonicalHashV1(matchedObservationMaterial(original))).not.toBe(
      canonicalHashV1(matchedObservationMaterial(changed)),
    )
})

test('future technical availability is rejected before a request can be reproduced', () => {
  const snapshot = technicalSnapshots().withTechnical
  const technical = snapshot.manifest.streaming.technical
  if (technical === undefined) throw new Error('Missing technical fixture')
  const future = {
    ...snapshot,
    manifest: {
      ...snapshot.manifest,
      streaming: {
        ...snapshot.manifest.streaming,
        technical: {
          ...technical,
          features: technical.features.map((feature) => ({
            ...feature,
            availableAtMs: Date.parse(snapshot.manifest.observedAt) + 1,
          })),
        },
      },
    },
  }
  expect(Result.isFailure(makeJevTradingSignalRequest(future, 'AAPL', 'SPY'))).toBeTrue()
})

test('matched reproduction binds the context that determines model quote ages and session timing', () => {
  const { snapshot, cut, query } = streamingFixture()
  const later = Result.getOrThrow(
    constructStreamingSnapshot(cut, {
      ...query,
      observedAt: new Date(Date.parse(query.observedAt) + 1000).toISOString(),
    }),
  )
  expect(Result.getOrThrow(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY')).requestHash).not.toBe(
    Result.getOrThrow(makeJevTradingSignalRequest(later, 'AAPL', 'SPY')).requestHash,
  )
  expect(canonicalHashV1(matchedObservationMaterial(snapshot))).not.toBe(
    canonicalHashV1(matchedObservationMaterial(later)),
  )
})

const fixture = nativeJevFixture()
const observedAt = Date.parse(fixture.observation.payload.observedAt)
const baseQuote = fixture.snapshot.latestQuotes['AAPL']
if (baseQuote === undefined) throw new Error('Missing lifecycle quote')
const assumptions = { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 }
const modelDelayMs = 5000

const quoteAt = (symbol: string, atMs: number) => {
  const terminal = atMs >= observedAt + 15 * 60_000
  const bid =
    symbol === 'AAPL' ? (terminal ? 102 : atMs >= observedAt + modelDelayMs ? 101 : 100) : terminal ? 101.6 : 100.4
  const value = {
    ...baseQuote,
    symbol,
    eventAt: new Date(atMs).toISOString(),
    ingestedAt: new Date(atMs).toISOString(),
    bidPrice: bid,
    askPrice: bid + 0.02,
    bidSize: 1000,
    askSize: 1000,
  }
  return { value, sequence: atMs - observedAt, availableAtMs: atMs, recordHash: canonicalHashV1(value) }
}

const replay = (symbol: string, decidedAtMs: number, missingPoll = false) => {
  const terms = {
    symbol,
    protocol: fixture.protocol,
    assumptions,
    entryBudgetMicros: matchedEntryDefinition.budgetMicros,
    decidedAtMs,
    cutoffMs: observedAt + 30 * 60_000,
    closeMs: observedAt + 35 * 60_000,
  }
  let state = Result.getOrThrow(createMatchedLifecycle(terms.entryBudgetMicros))
  const apply = (kind: MatchedEvent, atMs: number, absent = false) => {
    state = Result.getOrThrow(
      stepMatchedLifecycle(state, terms, {
        kind,
        atMs,
        quote: absent ? undefined : quoteAt(symbol, atMs),
      }),
    )
  }
  apply(MatchedEvent.EntryDecision, decidedAtMs)
  apply(MatchedEvent.EntryArrival, decidedAtMs + assumptions.latencyMs)
  for (let elapsed = 5000; elapsed <= 15 * 60_000; elapsed += 5000) {
    const atMs = decidedAtMs + assumptions.latencyMs + elapsed
    apply(MatchedEvent.Poll, atMs, missingPoll && elapsed === 5000)
    if (state.exit !== null) apply(MatchedEvent.ExitArrival, atMs + assumptions.latencyMs)
  }
  return finishMatchedLifecycle(state)
}

const registration: MatchedRegistration = {
  schemaVersion: 'bayn.matched-entry-registration.v1',
  definitionHash: canonicalHashV1(matchedEntryDefinition),
  sourceRevision: 'a'.repeat(40),
  protocolHash: canonicalHashV1(fixture.protocol),
  registeredAt: '2026-09-03T00:00:00.000Z',
  dataRole: MatchedDataRole.Prospective,
  sessionDates: ['2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
  latencyMs: assumptions.latencyMs,
  executionAssumptionsHash: canonicalHashV1(assumptions),
  latencyEvidenceHash: 'c'.repeat(64),
  capacityEvidenceHash: 'd'.repeat(64),
}

test('real lifecycle and summary can favor Jev selection while immediate momentum still wins', () => {
  const immediate = replay('AAPL', observedAt)
  const delayed = replay('AAPL', observedAt + modelDelayMs)
  const jev = replay('AMZN', observedAt + modelDelayMs)
  expect([immediate.status, delayed.status, jev.status]).toEqual(['RESOLVED', 'RESOLVED', 'RESOLVED'])
  const summary = summarizeMatchedPairs(
    registration,
    Array.from({ length: 20 }, (_, index) => ({
      batchId: canonicalHashV1({ index }),
      sessionDate: registration.sessionDates[index % 5] ?? '',
      jevSymbol: 'AMZN',
      momentumSymbol: 'AAPL',
      modelAvailable: true,
      jev,
      momentum: delayed,
      inferenceCostMicros: '1000000',
      sharedOperatingCostMicros: '0',
    })),
    [],
  )
  expect(summary.recommendation).toBe(MatchedRecommendation.TestPortfolio)
  const net = (outcome: typeof immediate) => {
    if (outcome.netExecutionPnlMicros === null) throw new Error('Expected complete synthetic outcome')
    return BigInt(outcome.netExecutionPnlMicros)
  }
  const selectionNet = net(jev) - 1000000n - net(delayed)
  const delayEffect = net(delayed) - net(immediate)
  const totalIncrement = net(jev) - 1000000n - net(immediate)
  expect(selectionNet).toBeGreaterThan(0n)
  expect(totalIncrement).toBeLessThan(0n)
  expect(selectionNet + delayEffect).toBe(totalIncrement)
})

test('missing post-entry observations cannot be dropped after seeing model selection', () => {
  const complete = replay('AAPL', observedAt)
  const incomplete = replay('AMZN', observedAt + modelDelayMs, true)
  expect(incomplete.status).toBe('UNRESOLVED')
  expect(incomplete.netExecutionPnlMicros).toBeNull()
  const summary = summarizeMatchedPairs(
    registration,
    [
      {
        batchId: canonicalHashV1({ missingPoll: true }),
        sessionDate: registration.sessionDates[0] ?? '',
        jevSymbol: 'AMZN',
        momentumSymbol: 'AAPL',
        modelAvailable: true,
        jev: incomplete,
        momentum: complete,
        inferenceCostMicros: '1000000',
        sharedOperatingCostMicros: '0',
      },
    ],
    [],
  )
  expect(summary.completion).toBe('INCOMPLETE')
  expect(summary.means.incrementalBudgetReturnBps).toBeNull()
})

test('an earlier abstention changes the next opportunity through each portfolio own inventory', () => {
  const empty = Result.getOrThrow(createControlPortfolio('100000000000'))
  const buy = (symbol: string, decisionAtMs: number) => ({
    symbol,
    side: OrderSide.Buy,
    quantityMicros: 10_000_000n,
    protocol: fixture.protocol,
    assumptions,
    decisionAtMs,
    arrivalAtMs: decisionAtMs + assumptions.latencyMs,
    decisionQuote: quoteAt(symbol, decisionAtMs),
    arrivalQuote: quoteAt(symbol, decisionAtMs + assumptions.latencyMs),
  })
  const momentum = Result.getOrThrow(applyControlOrder(empty, buy('AAPL', observedAt))).portfolio
  const next = buy('AMZN', observedAt + 5 * 60_000)
  expect(Result.isFailure(applyControlOrder(momentum, next))).toBeTrue()
  const jevAfterAbstention = Result.getOrThrow(applyControlOrder(empty, next)).portfolio
  expect(momentum.ledger.positions.map((position) => position.symbol)).toEqual(['AAPL'])
  expect(jevAfterAbstention.ledger.positions.map((position) => position.symbol)).toEqual(['AMZN'])
})
