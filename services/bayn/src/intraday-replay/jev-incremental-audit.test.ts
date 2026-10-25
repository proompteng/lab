import { replayTestInstruments } from '../testing/replay-instruments'
import { jevRequestForSnapshot } from '../jev/native.test-support'
import { equityMarketProfile } from '../jev/markets'
import { exchangeSessions } from '../market-hours'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { OrderSide } from '../execution/contracts'
import { nativeJevFixture } from '../jev/native.test-support'
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
const technicalSnapshots = (ema = '123450000', offset = '0', availabilityDelayMs = 0) => {
  const { snapshot, cut, query } = streamingFixture()
  const rolling = snapshot.manifest.streaming.features.find((entry) => entry.value.material.symbol === 'AAPL')
  const first = snapshot.bars.find((bar) => bar.symbol === 'AAPL')
  const session = exchangeSessions(snapshot.manifest.calendar)[0]
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
    universeId: equityMarketProfile.universeId,
    universeSymbolHash: equityMarketProfile.universeSymbolHash,
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
      featureId: Result.getOrThrow(canonicalHashV1Result(material)),
      producerRevision: 'incremental-audit-fixture',
      computedAtMs: Date.parse(query.observedAt),
    }),
  )
  const projection = incorporateMarketRecord(
    { ...cut.projection, technicalTopic: topic },
    { topic, partition: 0, offset, value: JSON.stringify(feature) },
    {
      universeId: equityMarketProfile.universeId,
      universeSymbolHash: equityMarketProfile.universeSymbolHash,
      symbols: equityMarketProfile.universe,
      topics: { ...equityMarketProfile.sourceTopics, features: rolling.topic, technicalFeatures: topic },
    },
    Date.parse(query.observedAt) + availabilityDelayMs,
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
  const actual = Result.getOrThrow(jevRequestForSnapshot(withTechnical, 'AAPL'))
  const missing = Result.getOrThrow(jevRequestForSnapshot(withoutTechnical, 'AAPL'))
  expect(actual.requestHash).not.toBe(missing.requestHash)
  expect(Result.getOrThrow(canonicalHashV1Result(matchedObservationMaterial(withTechnical)))).not.toBe(
    Result.getOrThrow(canonicalHashV1Result(matchedObservationMaterial(withoutTechnical))),
  )
})

test('matched reproduction binds changed technical values and their exact source coordinates', () => {
  const original = technicalSnapshots().withTechnical
  const differentValue = technicalSnapshots('99900000').withTechnical
  const differentSource = technicalSnapshots('123450000', '1').withTechnical
  const request = (snapshot: typeof original) => Result.getOrThrow(jevRequestForSnapshot(snapshot, 'AAPL')).requestHash
  expect(request(original)).not.toBe(request(differentValue))
  expect(request(original)).toBe(request(differentSource))
  for (const changed of [differentValue, differentSource])
    expect(Result.getOrThrow(canonicalHashV1Result(matchedObservationMaterial(original)))).not.toBe(
      Result.getOrThrow(canonicalHashV1Result(matchedObservationMaterial(changed))),
    )
})

test('future technical availability is excluded by real snapshot construction before model input', () => {
  const { withTechnical: future, withoutTechnical } = technicalSnapshots('123450000', '0', 1)
  expect(future.manifest.streaming.technical?.features).toHaveLength(0)
  const request = Result.getOrThrow(jevRequestForSnapshot(future, 'AAPL'))
  const absent = Result.getOrThrow(jevRequestForSnapshot(withoutTechnical, 'AAPL'))
  expect(request.requestHash).toBe(absent.requestHash)
})

test('matched reproduction binds the context that determines model quote ages and session timing', () => {
  const { snapshot, cut, query } = streamingFixture()
  const later = Result.getOrThrow(
    constructStreamingSnapshot(cut, {
      ...query,
      observedAt: new Date(Date.parse(query.observedAt) + 1000).toISOString(),
    }),
  )
  expect(Result.getOrThrow(jevRequestForSnapshot(snapshot, 'AAPL')).requestHash).not.toBe(
    Result.getOrThrow(jevRequestForSnapshot(later, 'AAPL')).requestHash,
  )
  expect(Result.getOrThrow(canonicalHashV1Result(matchedObservationMaterial(snapshot)))).not.toBe(
    Result.getOrThrow(canonicalHashV1Result(matchedObservationMaterial(later))),
  )
})

const fixture = nativeJevFixture()
const observedAt = Date.parse(fixture.observation.payload.observedAt)
const baseQuote = fixture.snapshot.latestQuotes['AAPL']
if (baseQuote === undefined) throw new Error('Missing lifecycle quote')
const assumptions = {
  instruments: replayTestInstruments,
  latencyMs: 100,
  slippageBps: 0,
  availableLiquidityPpm: 1000000,
  feeMultiplierPpm: 1000000,
}
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
  return {
    value,
    sequence: atMs - observedAt,
    availableAtMs: atMs,
    recordHash: Result.getOrThrow(canonicalHashV1Result(value)),
  }
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
  schemaVersion: 'bayn.matched-entry-registration.v2',
  definitionHash: Result.getOrThrow(canonicalHashV1Result(matchedEntryDefinition)),
  sourceRevision: 'a'.repeat(40),
  protocolHash: Result.getOrThrow(canonicalHashV1Result(fixture.protocol)),
  registeredAt: '2026-09-03T00:00:00.000Z',
  dataRole: MatchedDataRole.Prospective,
  sessionDates: ['2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
  latencyMs: assumptions.latencyMs,
  executionAssumptionsHash: Result.getOrThrow(canonicalHashV1Result(assumptions)),
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
      batchId: Result.getOrThrow(canonicalHashV1Result({ index })),
      sessionDate: registration.sessionDates[index % 5] ?? '',
      jevSymbol: 'AMZN',
      momentumSymbol: 'AAPL',
      modelAvailable: true,
      jev,
      delayedMomentum: delayed,
      immediateMomentum: immediate,
      timingAvailable: true,
      inferenceCostMicros: '1000000',
      sharedOperatingCostMicros: '0',
    })),
    [],
  )
  expect(summary.recommendation).toBe(MatchedRecommendation.Stop)
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
        batchId: Result.getOrThrow(canonicalHashV1Result({ missingPoll: true })),
        sessionDate: registration.sessionDates[0] ?? '',
        jevSymbol: 'AMZN',
        momentumSymbol: 'AAPL',
        modelAvailable: true,
        jev: incomplete,
        delayedMomentum: complete,
        immediateMomentum: complete,
        timingAvailable: true,
        inferenceCostMicros: '1000000',
        sharedOperatingCostMicros: '0',
      },
    ],
    [],
  )
  expect(summary.completion).toBe('INCOMPLETE')
  expect(summary.means.totalBudgetReturnBps).toBeNull()
})

test('an earlier abstention changes the next opportunity through each portfolio own inventory', () => {
  const empty = Result.getOrThrow(createControlPortfolio('100000000000'))
  const buy = (symbol: string, decisionAtMs: number) => ({
    symbol,
    side: OrderSide.Buy,
    quantityAtoms: 10000000000n,
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
