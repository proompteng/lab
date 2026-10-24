import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { StrategySnapshotManifestSchema } from '../src/market-data/streaming/manifest-schema'

import { decideJevEntry } from '../src/jev/decision'
import { nativeJevDecisionEvidence } from '../src/jev/native.test-support'
import { jevObservationForSnapshot } from '../src/jev/native.test-support'
import { cryptoMarketFixture } from '../src/testing/crypto-market-fixture'
import { nativeJevFixture } from '../src/jev/native.test-support'
import { canonicalHashV1Result, sha256 } from '../src/hash'
import {
  makeNativeArrivalChunk,
  nativeArrival,
  nativeArrivalCaptureId,
} from '../src/market-data/streaming/native-arrival'
import {
  nativeArrivalEpochFixture,
  nativeArrivalObservationFixture,
} from '../src/market-data/streaming/native-arrival.test-support'
import { replayTestInstruments } from '../src/testing/replay-instruments'
import {
  reportAuditedJevPlanPath,
  reportJevAbstention,
  reportJevRealizedEvidence,
  reportJevPlanPath,
  summarizeJevChoiceMass,
} from './jev-abstention-report'

const joinFixture = (crypto = false) => {
  const observation = crypto
    ? Result.getOrThrow(
        jevObservationForSnapshot(cryptoMarketFixture('SOL/USD', { observedPriceChoices: true }).snapshot),
      )
    : null
  const evidence =
    observation === null
      ? null
      : nativeJevDecisionEvidence({ observation, protocol: observation.payload.protocol }, 'enter')
  const decision =
    evidence === null
      ? documentFor('enter')
      : {
          mode: 'PAPER',
          bindings: { cycleId: evidence.observation.cycleId },
          strategyDecision: Result.getOrThrow(decideJevEntry(evidence)),
        }
  const symbol = crypto ? 'SOL/USD' : 'AAPL'
  const cycleId = decision.bindings.cycleId
  const strategyDecisionHash = Result.getOrThrow(canonicalHashV1Result(decision.strategyDecision))
  const accountId = decision.strategyDecision.evidence.observation.portfolio.brokerState.account.accountId
  const at = Date.parse(decision.strategyDecision.observedAt)
  const transaction = (side: 'BUY' | 'SELL', id: string, delta: number) => ({
    schemaVersion: 'bayn.accounting-transaction.v2',
    transactionId: id.repeat(64),
    brokerEventId: id.repeat(64),
    intentId: id.repeat(64),
    accountId,
    symbol,
    side,
    quantityAtoms: '1000000',
    priceAtoms: '100000000000',
    notionalMicros: '100000000',
    feeMicros: '0',
    costBasisMicros: '100000000',
    realizedPnlMicros: '0',
    quantityDeltaAtoms: side === 'BUY' ? '1000000' : '-1000000',
    costBasisDeltaMicros: side === 'BUY' ? '100000000' : '-100000000',
    cashDeltaMicros: side === 'BUY' ? '-100000000' : '100000000',
    ledgerPlanHash: id.repeat(64),
    contentHash: id.repeat(64),
    occurredAt: new Date(at + delta).toISOString(),
  })
  const trades = [transaction('BUY', 'a', 1000), transaction('SELL', 'b', 2000)]
  const value = {
    openingTransactionId: 'a'.repeat(64),
    closingTransactionId: 'b'.repeat(64),
    symbol,
    openedAt: new Date(at + 1000).toISOString(),
    closedAt: new Date(at + 2000).toISOString(),
    holdingDurationMs: 1000,
    buyFillCount: 1,
    sellFillCount: 1,
    buyNotionalMicros: '100000000',
    turnoverMicros: '200000000',
    grossRealizedPnlMicros: '0',
    costs: {
      status: 'UNDETERMINED',
      reason: 'NON_CRYPTO_ALLOCATION_UNAVAILABLE',
      attributedCostMicros: null,
      netPnlAfterAttributedCostsMicros: null,
      allInProfitMicros: null,
    },
  }
  return {
    schemaVersion: 'bayn.jev-realized-evidence-input.v1',
    cycles: [
      {
        cycleId,
        state: 'COMPLETED',
        sourceRevision: 'c'.repeat(40),
        authorityGenerationHash: decision.strategyDecision.evidence.observation.authorityGenerationHash,
        decisionDocument: decision,
        strategyDecisionHash,
        transactions: trades.map((transaction) => ({ cycleId, strategyDecisionHash, transaction })),
        outcome: { contentHash: Result.getOrThrow(canonicalHashV1Result(value)), value },
        exitObservation: {
          cycleId,
          openingTransactionId: 'a'.repeat(64),
          sourceHash: 'e'.repeat(64),
          reason: 'RECOVERY',
        },
      },
    ],
  }
}

test('realized join preserves imported unknown costs and does not turn recovery into a target/stop label', () => {
  const report = reportJevRealizedEvidence(joinFixture())
  expect(report.qualification).toBe('UNQUALIFIED_IMPORTED_EVIDENCE_JOIN')
  expect(report.rows[0]?.observedExit?.reason).toBe('RECOVERY')
  expect(report.rows[0]?.targetBeforeStop).toBe('UNKNOWN')
  expect(report.rows[0]?.targetPathCensored).toBe(true)
  expect(report.rows[0]?.importedOutcome?.costs.netPnlAfterAttributedCostsMicros).toBeNull()
  expect(report.rows[0]?.allInProfitMicros).toBeNull()
})

test('realized join retains blocked missing-model and abstention denominator rows and source strata', () => {
  const decision = documentFor()
  const base = {
    sourceRevision: 'a'.repeat(40),
    authorityGenerationHash: 'b'.repeat(64),
    transactions: [],
    outcome: null,
    exitObservation: null,
  }
  const report = reportJevRealizedEvidence({
    schemaVersion: 'bayn.jev-realized-evidence-input.v1',
    cycles: [
      { ...base, cycleId: 'c'.repeat(64), state: 'BLOCKED', decisionDocument: null, strategyDecisionHash: null },
      {
        ...base,
        sourceRevision: 'd'.repeat(40),
        authorityGenerationHash: decision.strategyDecision.evidence.observation.authorityGenerationHash,
        cycleId: decision.bindings.cycleId,
        state: 'NO_TRADE',
        decisionDocument: decision,
        strategyDecisionHash: Result.getOrThrow(canonicalHashV1Result(decision.strategyDecision)),
      },
    ],
  })
  expect(report.denominatorCount).toBe(2)
  expect(report.rows[0]?.decision).toBeNull()
  expect(report.rows[1]?.decision?.selectedSymbols).toEqual([])
  expect(report.rows[0]?.sourceRevision).not.toBe(report.rows[1]?.sourceRevision)
  expect(report.completeOpportunityScheduleProven).toBe(false)
})

test.each(['cycle', 'decision', 'authority', 'transaction', 'duplicate', 'outcome', 'exit', 'unknown-field'])(
  'realized join rejects %s substitution',
  (kind) => {
    const input = joinFixture()
    const row = input.cycles[0]
    if (row === undefined) throw new Error('Missing row')
    if (kind === 'cycle') row.cycleId = 'f'.repeat(64)
    if (kind === 'decision') row.strategyDecisionHash = 'f'.repeat(64)
    if (kind === 'authority') row.authorityGenerationHash = 'f'.repeat(64)
    if (kind === 'transaction') {
      const link = row.transactions[0]
      if (link !== undefined) link.cycleId = 'f'.repeat(64)
    }
    if (kind === 'duplicate') input.cycles.push(row)
    if (kind === 'outcome') row.outcome.value.grossRealizedPnlMicros = '123'
    if (kind === 'exit') row.exitObservation.openingTransactionId = 'f'.repeat(64)
    if (kind === 'unknown-field') Object.assign(row, { calibratedProfitProbability: 0.9 })
    expect(() => reportJevRealizedEvidence(input)).toThrow()
  },
)

test.each(['ACTIVE', 'BLOCKED'])(
  'realized join retains %s partial execution without manufacturing a closed return',
  (state) => {
    const input = joinFixture()
    const row = input.cycles[0]
    if (row === undefined) throw new Error('Missing row')
    const report = reportJevRealizedEvidence({
      ...input,
      cycles: [{ ...row, state, transactions: row.transactions.slice(0, 1), outcome: null, exitObservation: null }],
    })
    expect(report.rows[0]?.executionEvidence).toBe('UNKNOWN_OR_OPEN')
    expect(report.rows[0]?.importedOutcome).toBeNull()
    expect(report.rows[0]?.targetBeforeStop).toBe('UNKNOWN')
  },
)

test('realized join preserves imported crypto accrued costs once and rejects resealed wrong net', () => {
  const input = joinFixture(true)
  const row = input.cycles[0]
  if (row === undefined) throw new Error('Missing row')
  const value = {
    ...row.outcome.value,
    costs: {
      status: 'ATTRIBUTED_ACCRUALS',
      scope: 'FILL_FEES_AND_SOURCE_LINKED_ACCRUALS',
      attributedCostMicros: '100',
      netPnlAfterAttributedCostsMicros: '-100',
      finalExecutionCostCoverage: 'UNDETERMINED',
      brokerActivityAdjustmentsIncluded: false,
      allInProfitMicros: null,
    },
  }
  const withOutcome = () => ({
    ...input,
    cycles: [
      {
        ...row,
        outcome: {
          value,
          contentHash: Result.getOrThrow(canonicalHashV1Result(value)),
        },
      },
    ],
  })
  const report = reportJevRealizedEvidence(withOutcome())
  expect(report.rows[0]?.importedOutcome?.costs.netPnlAfterAttributedCostsMicros).toBe('-100')
  expect(report.independentlyVerifiedLedger).toBe(false)
  value.costs.netPnlAfterAttributedCostsMicros = '-200'
  expect(() => reportJevRealizedEvidence(withOutcome())).toThrow('Imported attributed net is inconsistent')
  value.costs.netPnlAfterAttributedCostsMicros = '-100'
  const first = row.transactions[0]
  if (first === undefined) throw new Error('Missing fill')
  first.transaction.feeMicros = '101'
  expect(() => reportJevRealizedEvidence(withOutcome())).toThrow('Imported attributed net is inconsistent')
})

const documentFor = (action = 'wait') => {
  const evidence = nativeJevDecisionEvidence(undefined, action)
  return {
    mode: 'PAPER',
    bindings: { cycleId: evidence.observation.cycleId },
    strategyDecision: Result.getOrThrow(decideJevEntry(evidence)),
  }
}

const pathFixture = () => {
  const document = documentFor()
  const target = document.strategyDecision
  const candidate = target.evidence.batchPlan.candidates.find((value) => value.symbol === 'AAPL')
  if (candidate?.status !== 'REQUESTED') throw new Error('Missing requested fixture')
  const question = candidate.request.request.questions['action']
  if (question?.type !== 'choice') throw new Error('Missing fixture question')
  const original = nativeJevFixture().snapshot.latestQuotes['AAPL']
  if (original === undefined) throw new Error('Missing native fixture quote')
  const at = Date.parse(target.observedAt)
  const assumptions = {
    schemaVersion: 'bayn.jev-plan-path-assumptions.v1',
    decisionHash: Result.getOrThrow(canonicalHashV1Result(target)),
    sourceEvidenceSha256: 'a'.repeat(64),
    symbol: 'AAPL',
    choice: 'plan_0',
    windowAnchor: 'OBSERVATION',
    windowStartAt: target.observedAt,
    entryLatencyMs: 10,
    quantityAtoms: '1000000000',
    feeMultiplierPpm: 1_000_000,
    instruments: replayTestInstruments,
    fillAssumption: 'NOT_SIMULATED',
  }
  const plan = (
    question.criteria['plan_0'] as { plan: { levels: { stopPriceMicros: string; profitLimitPriceMicros: string } } }
  ).plan
  const quote = (delay: number, sequence: number, bid: number, eventDelay = delay) => ({
    value: {
      ...original,
      bidPrice: bid,
      askPrice: bid + 0.01,
      bidSize: 100,
      askSize: 100,
      eventAt: new Date(at + eventDelay).toISOString(),
      ingestedAt: new Date(at + delay).toISOString(),
    },
    availableAtMs: at + delay,
    sequence,
    recordHash: sequence.toString(16).padStart(64, '0'),
  })
  return {
    document,
    assumptions,
    at,
    quote,
    stop: Number(plan.levels.stopPriceMicros) / 1e6,
    target: Number(plan.levels.profitLimitPriceMicros) / 1e6,
  }
}

const auditedPathFixture = (
  change:
    | 'none'
    | 'epoch'
    | 'interval'
    | 'sequence'
    | 'bootstrap'
    | 'source'
    | 'offset'
    | 'partition'
    | 'extra-partition'
    | 'topic' = 'none',
) => {
  const f = pathFixture()
  const manifest = Result.getOrThrow(
    Schema.decodeUnknownResult(StrategySnapshotManifestSchema)(
      f.document.strategyDecision.evidence.observation.manifest,
    ),
  )
  if (manifest.schemaVersion !== 'bayn.streaming-market-snapshot.v1') throw new Error('Expected streaming fixture')
  const original = f.quote(0, 1, f.target).value
  const bootstrap = {
    ...manifest.streaming.bootstrap,
    epoch: change === 'epoch' ? 'foreign-epoch' : manifest.streaming.bootstrap.epoch,
    lowerTimestampMs: manifest.streaming.bootstrap.lowerTimestampMs - (change === 'bootstrap' ? 1 : 0),
    partitions: manifest.streaming.bootstrap.partitions.flatMap((partition, index) =>
      change === 'partition' && index === 0
        ? []
        : [{ ...partition, startOffset: change === 'offset' && index === 0 ? '1' : partition.startOffset }],
    ),
  }
  if (change === 'extra-partition')
    bootstrap.partitions.push({
      topic: manifest.sourceTopics.quotes,
      partition: 99,
      logStartOffset: '0',
      startOffset: '0',
      endOffset: '0',
    })
  const sources = [
    {
      universeId: change === 'source' ? 'foreign-source' : manifest.universeId,
      universeSymbolHash: manifest.universeSymbolHash,
      symbols: ['AAPL'],
      topics: {
        ...manifest.sourceTopics,
        bars: change === 'topic' ? 'foreign-bars-topic' : manifest.sourceTopics.bars,
        features: 'torghut.market-features.v1',
      },
    },
  ] as const
  const build = nativeArrivalEpochFixture.build
  const epoch = {
    ...nativeArrivalEpochFixture,
    bootstrap,
    sources,
    captureId: Result.getOrThrow(nativeArrivalCaptureId(build, bootstrap, sources)),
  }
  const arrivals = [-1, 100, 900001].map((delay, index) => {
    const at = new Date(f.at + delay).toISOString()
    const value = JSON.stringify({
      provider: 'alpaca',
      feed: original.feed,
      delayClass: original.delayClass,
      marketSession: original.marketSession,
      channel: 'quotes',
      seq: index + 1,
      symbol: 'AAPL',
      version: 2,
      eventTs: at,
      ingestTs: at,
      payload: {
        T: 'q',
        S: 'AAPL',
        t: at,
        bp: f.target,
        bs: 100,
        ap: f.target + 0.01,
        as: 100,
        bx: 'V',
        ax: 'V',
        c: [],
        z: 'C',
      },
    })
    const observation = nativeArrivalObservationFixture(index + 1, value)
    return nativeArrival(epoch, {
      ...observation,
      record: { ...observation.record, topic: manifest.sourceTopics.quotes, timestampMs: f.at + delay },
      availableAtMs: f.at + delay,
      projectionSequence: manifest.streaming.sequence + index - (change === 'sequence' ? 1 : 0),
    })
  })
  const chunk = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, arrivals))
  const bundle = {
    epoch: { epoch, contentHash: Result.getOrThrow(canonicalHashV1Result(epoch)) },
    headers: [{ contentHash: chunk.contentHash, header: chunk.header }],
    chunks: [
      {
        contentHash: chunk.contentHash,
        header: chunk.header,
        compressedBase64: Buffer.from(chunk.compressed).toString('base64'),
      },
    ],
    end: null,
    interval: { startMs: f.at, endMs: f.at + 900000 - (change === 'interval' ? 1 : 0) },
    symbols: ['AAPL'],
  }
  const sourceBundle = Buffer.from(JSON.stringify(bundle))
  return {
    decisionDocument: f.document,
    assumptions: { ...f.assumptions, sourceEvidenceSha256: sha256(sourceBundle) },
    sourceBundle,
  }
}

test('audited bytes preserve unknown controller coverage and exact plan observations', () => {
  const report = reportAuditedJevPlanPath(auditedPathFixture())
  expect(report.observedOrder).toBe('TARGET_OBSERVED_FIRST')
  expect(report.sourceAudit.controllerCoverage).toBe('UNKNOWN')
  expect(report.status).toBe('INCOMPLETE')
  expect(report.netEconomicPnlMicros).toBeNull()
})

for (const change of [
  'epoch',
  'interval',
  'sequence',
  'bootstrap',
  'source',
  'offset',
  'partition',
  'extra-partition',
  'topic',
] as const)
  test(`audited source rejects foreign ${change}`, () => {
    expect(() => reportAuditedJevPlanPath(auditedPathFixture(change))).toThrow(
      change === 'sequence' ? 'does not follow the sealed observation sequence' : 'differs from the sealed observation',
    )
  })

test('audited source rejects changed bytes despite a supplied source hash', () => {
  const input = auditedPathFixture()
  expect(() =>
    reportAuditedJevPlanPath({ ...input, sourceBundle: Buffer.concat([input.sourceBundle, Buffer.from(' ')]) }),
  ).toThrow('bytes differ')
})

test('actual plan thresholds and causal delivery order remain descriptives, never PnL', () => {
  const f = pathFixture()
  const original = JSON.stringify(f.document)
  const report = reportJevPlanPath({
    decisionDocument: f.document,
    assumptions: f.assumptions,
    sourceEvidenceSha256: 'a'.repeat(64),
    quotes: [f.quote(100, 1, f.target), f.quote(100, 2, f.stop)],
  })
  expect(report.observedOrder).toBe('TARGET_OBSERVED_FIRST')
  expect(report.firstTarget?.sequence).toBe(1)
  expect(report.firstStop?.sequence).toBe(2)
  expect(report.coverage.acceptedQuotes).toBe(2)
  expect(report).toMatchObject({
    status: 'INCOMPLETE',
    qualification: 'UNQUALIFIED',
    netEconomicPnlMicros: null,
    actualExecutionProven: false,
    originalSelectedSymbols: [],
  })
  expect(report.unsupported).toContain('NATIVE_GTC_AND_CONTROLLER_REPLAY')
  expect(JSON.stringify(f.document)).toBe(original)
  expect(report.hypotheticalEntryArrivalAt).toBe(new Date(f.at + 10).toISOString())
})

test('missing and stale original quotes cannot become resolved outcomes', () => {
  const f = pathFixture()
  const base = { decisionDocument: f.document, assumptions: f.assumptions, sourceEvidenceSha256: 'a'.repeat(64) }
  const empty = reportJevPlanPath({ ...base, quotes: [] })
  expect(empty.observedOrder).toBe('NO_THRESHOLD_OBSERVED')
  expect(empty.coverage.firstAt).toBeNull()
  expect(empty.coverage.largestGapMs).toBe(900_000)
  const staleAge = f.document.strategyDecision.evidence.observation.protocol.maximumQuoteAgeMs + 1
  const stale = reportJevPlanPath({ ...base, quotes: [f.quote(staleAge, 1, f.target, 0)] })
  expect(stale.firstTarget).toBeNull()
  expect(stale.coverage.acceptedQuotes).toBe(0)
  expect(Object.values(stale.coverage.rejected)).toEqual([1])
  expect(stale.netEconomicPnlMicros).toBeNull()
})

for (const patch of [
  { feeMultiplierPpm: 999999 },
  { quantityAtoms: '999999999999999999999' },
  { decisionHash: 'b'.repeat(64) },
  { sourceEvidenceSha256: 'b'.repeat(64) },
  { entryLatencyMs: 60000 },
  { choice: 'plan_999' },
  { fillAssumption: 'FILLED' },
  { unsupportedExecutionAssumption: 'instant-fill' },
])
  test(`assumptions reject ${Object.keys(patch)[0]}`, () => {
    const f = pathFixture()
    expect(() =>
      reportJevPlanPath({
        decisionDocument: f.document,
        assumptions: { ...f.assumptions, ...patch },
        sourceEvidenceSha256: 'a'.repeat(64),
        quotes: [],
      }),
    ).toThrow()
  })

test('observation and hypothetical first-fill clocks stay explicitly distinct', () => {
  const f = pathFixture()
  const run = (patch: Record<string, unknown>) =>
    reportJevPlanPath({
      decisionDocument: f.document,
      assumptions: { ...f.assumptions, ...patch },
      sourceEvidenceSha256: 'a'.repeat(64),
      quotes: [],
    })
  expect(() => run({ windowStartAt: new Date(f.at + 1).toISOString() })).toThrow()
  const hypothetical = run({
    windowAnchor: 'HYPOTHETICAL_FIRST_FILL',
    windowStartAt: new Date(f.at + 20).toISOString(),
  })
  expect(hypothetical.windowEndAt).toBe(new Date(f.at + 20 + 900000).toISOString())
  expect(hypothetical.netEconomicPnlMicros).toBeNull()
})

test('quote order is validated rather than sorted into a favorable outcome', () => {
  const f = pathFixture()
  const run = (quotes: ReturnType<typeof f.quote>[]) =>
    reportJevPlanPath({
      decisionDocument: f.document,
      assumptions: f.assumptions,
      sourceEvidenceSha256: 'a'.repeat(64),
      quotes,
    })
  expect(() => run([f.quote(200, 2, f.target), f.quote(100, 1, f.stop)])).toThrow()
  expect(() => run([f.quote(100, 1, f.target), f.quote(200, 1, f.stop)])).toThrow()
  expect(run([f.quote(100, 1, f.stop), f.quote(200, 2, f.target)]).observedOrder).toBe('STOP_OBSERVED_FIRST')
})

test('historical entry contracts are refused rather than relabeled', () => {
  const document = documentFor()
  expect(() =>
    reportJevAbstention({
      ...document,
      strategyDecision: { ...document.strategyDecision, schemaVersion: 'bayn.jev-entry-target.v5' },
    }),
  ).toThrow('source revision matching the original contract')
})

test('sealed wait diagnostics preserve decisions and distinguish protocol from input versions', () => {
  const document = documentFor()
  const original = JSON.stringify(document)
  const report = reportJevAbstention(document)
  expect(report).toMatchObject({
    diagnosticOnly: true,
    schemaVersion: 'bayn.jev-abstention-report.v2',
    protocol: 'bayn.jev.protocol.v21',
    inputDefinition: 'bayn.jev-trading-signal-state.v18',
    selectedSymbols: [],
    profitableEdgeProven: false,
  })
  const candidate = report.candidates.find((value) => value.symbol === 'AAPL')
  expect(candidate).toMatchObject({
    chosenAction: 'wait',
    chosenSetup: 'upward',
    setupProbabilities: { upward: 0.8 },
    planChoiceCondition: 'SUPPORTED_LONG_SETUP_ASSUMED',
    rejection: 'MODEL_WAIT',
    fundedPlanCount: 16,
    horizonMinutes: 15,
    choiceMass: { waitMass: 0.8 },
    coverage: { suppliedBarCount: 30 },
  })
  expect(JSON.stringify(document)).toBe(original)
  expect(reportJevAbstention(document)).toEqual(report)
})

test('reports accepted plans without altering selection and rejects tampered decisions or source requests', () => {
  const document = documentFor('enter')
  expect(reportJevAbstention(document).selectedSymbols).toEqual(document.strategyDecision.selectedSymbols)
  expect(() => reportJevAbstention({ ...document, bindings: { cycleId: 'f'.repeat(64) } })).toThrow()
  expect(() =>
    reportJevAbstention({ ...document, strategyDecision: { ...document.strategyDecision, selectedSymbols: [] } }),
  ).toThrow()
  const altered = JSON.parse(JSON.stringify(document))
  altered.strategyDecision.evidence.batchPlan.candidates[0].request.request.state.task.horizonMinutes = 60
  expect(() => reportJevAbstention(altered)).toThrow()
})

test('fragmented categorical plan mass is not a profit probability or permission to override argmax', () => {
  const probabilities = {
    wait: 0.3,
    avoid: 0.1,
    ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`plan_${i}`, 0.6 / 16])),
  }
  const summary = summarizeJevChoiceMass(probabilities)
  expect(summary.interpretation).toBe('CATEGORICAL_CHOICE_MASS_NOT_PROFIT_PROBABILITY')
  expect(summary.aggregatePlanMass).toBeCloseTo(0.6)
  expect(summary.maximumPlanMass).toBe(0.0375)
  expect(Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0]).toBe('wait')
  expect(summarizeJevChoiceMass({ wait: 0.7, avoid: 0.3 })).toMatchObject({
    aggregatePlanMass: 0,
    maximumPlanMass: null,
  })

  expect(
    summarizeJevChoiceMass(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`plan_${i}`, 0.063])))
      .aggregatePlanMass,
  ).toBeCloseTo(1.008)
})

test('crypto economics and coverage are measured from sealed source rather than choice mass', () => {
  const { snapshot } = cryptoMarketFixture('SOL/USD', { observedPriceChoices: true })
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot))
  const evidence = nativeJevDecisionEvidence({ observation, protocol: observation.payload.protocol }, 'wait')
  const strategyDecision = Result.getOrThrow(decideJevEntry(evidence))
  const report = reportJevAbstention({
    mode: 'PAPER',
    bindings: { cycleId: observation.payload.cycleId },
    strategyDecision,
  })
  const candidate = report.candidates.find((value) => value.symbol === 'SOL/USD')
  if (candidate === undefined || !('plans' in candidate) || !('coverage' in candidate))
    throw new Error('Expected requested SOL candidate')
  expect(candidate.fees).toEqual({ estimatedFeeBpsPerSide: 25, estimatedRoundTripFeesBps: 50 })
  expect(candidate.entryEconomics?.holdingExitRequiredBidRiseBps).toBeGreaterThan(80)
  expect(candidate.plans.length).toBeGreaterThan(0)
  expect(candidate.netRewardRisk).toEqual({
    minimum: Math.min(...candidate.plans.map((plan) => plan.netRewardRisk)),
    maximum: Math.max(...candidate.plans.map((plan) => plan.netRewardRisk)),
  })
  for (const plan of candidate.plans) {
    expect(plan.netRewardRisk).toBeCloseTo(plan.estimatedProfitUsd / plan.estimatedLossUsd)
    expect(plan.targetRiseFromBidBps).toBeGreaterThan(
      candidate.entryEconomics?.takeProfitRequiredBidRiseBps ?? Infinity,
    )
  }
  const bars = snapshot.bars.filter((bar) => bar.symbol === 'SOL/USD')
  expect(candidate.coverage.suppliedBarCount).toBe(bars.length)
  expect(candidate.coverage.zeroVolumeBarCount).toBe(bars.filter((bar) => bar.volume === 0).length)
  expect(candidate.coverage.unknownTradeCountBarCount).toBe(bars.filter((bar) => bar.tradeCount === null).length)
})
