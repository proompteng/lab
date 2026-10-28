import { beforeAll, expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { createReplayLedger, applyReplayFill } from '../intraday-replay/ledger'
import { registeredReplayInferenceTariff } from '../intraday-replay/inference-costs'
import { JevResearchPolicy } from '../jev/acceptance'
import { assessmentFixture, testHash } from './fixtures.test-support'
import { frozenControlReplayFixture } from './frozen-control.test-support'
import { prepareFrozenControlReplay } from './frozen-control-replay'
import {
  decodeFrozenAccountingRow,
  FrozenControlReportSchema,
  frozenQuantityAtoms,
  reproduceFrozenControlReport,
} from './frozen-control-report'
import { bindLatencyStressSources } from './latency-report'
import { sha256 } from '../hash'

let fixture: Awaited<ReturnType<typeof frozenControlReplayFixture>>
let prepared: Result.Result.Success<ReturnType<typeof prepareFrozenControlReplay>>
let report: ReturnType<typeof makeReport>
let costs: ReturnType<typeof makeCosts>
let sources: Set<string>
const seal = (body: Record<string, unknown>) => ({
  ...body,
  reportHash: Result.getOrThrow(canonicalHashV1Result(body)),
})
const makeReport = (prepared: Result.Result.Success<ReturnType<typeof prepareFrozenControlReplay>>) => {
  const { registration } = prepared.stress
  const first = registration.calendar.sessions[0]!
  const broker = {
    runId: prepared.engineRunId,
    accountId: `replay-${prepared.engineRunId}`,
    ledger: Result.getOrThrow(createReplayLedger(prepared.input.backtest.openingCashMicros)),
    orders: [],
    fills: [],
    fees: [],
    sessionCloses: registration.calendar.sessions.map((session) => ({
      sessionDate: session.sessionDate,
      equityMicros: prepared.input.backtest.openingCashMicros,
    })),
  }
  return {
    schemaVersion: 'bayn.frozen-control-latency-report.v1',
    runId: prepared.runId,
    engineRunId: prepared.engineRunId,
    executableSha256: testHash('compiled original offline policy'),
    evidenceMode: 'simulated-production-execution',
    completion: 'COMPLETE',
    issues: [],
    sourceReceiptHash: prepared.captureHash,
    assumptions: prepared.input.backtest.assumptions,
    source: {
      runId: prepared.engineRunId,
      sourceManifestHash: testHash(prepared.input.backtest.source),
      featureTopic: prepared.input.backtest.source.universe.topics.features,
      deliveryModel: prepared.input.backtest.source.deliveryModel,
    },
    frozenRequest: prepared.input,
    frozenProtocol: prepared.input.protocol,
    build: {
      ...prepared.input.backtest.build,
      declaredImageDigest: prepared.input.backtest.build.imageDigest,
      sourceAndStrategyVerification: 'embedded',
    },
    sessionDates: prepared.input.backtest.sessionDates,
    frozenLatency: {
      p95FullBatchMs: prepared.stress.p95FullBatchMs,
      opening: { createdAt: first.openAt, state: { ...broker, sessionCloses: [] } },
      receipts: [],
    },
    decisions: [],
    closingDecisions: [],
    brokerState: broker,
    sessions: registration.calendar.sessions.map((session) => ({
      sessionDate: session.sessionDate,
      completion: 'COMPLETE',
      issues: [],
      valuationFailureCount: 0,
      schedule: {
        firstPollAtMs: Date.parse(session.openAt),
        lastPollAtMs: Date.parse(session.closeAt),
        completedAtMs: Date.parse(session.closeAt),
        passCount: 2,
        failedPassCount: 0,
        unavailableDecisionPassCount: 0,
      },
      closingEquity: { equityMicros: prepared.input.backtest.openingCashMicros, sessionDate: session.sessionDate },
      remainingPositions: [],
      reconciliation: {
        report: {
          reconciliation: { status: 'EXACT' },
          metrics: {
            accountingExact: true,
            discrepancyCount: 0,
            cashDifferenceMicros: '0',
            positionDifferenceMicros: '0',
            equityDifferenceMicros: '0',
            oldestUnknownMutationAgeMs: 0,
          },
        },
        brokerState: { unknownOrderCount: 0 },
        riskContext: { unknownMutationCount: 0 },
      },
    })),
    accountingEvidence: {
      encoding: 'postgres-json-text-preserving-numeric-precision',
      transactions: [],
      receipts: [],
      fees: [],
    },
  }
}
const makeCosts = (prepared: Result.Result.Success<ReturnType<typeof prepareFrozenControlReplay>>) => {
  const { registration } = prepared.stress
  const f = assessmentFixture(registration)
  const policy = f.input.policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)!
  const windows = registration.calendar.sessions
  return {
    sources: f.verifiedSources,
    costs: {
      policy: JevResearchPolicy.Deployed,
      allocationRuleHash: prepared.definition.costAllocationRuleHash,
      asOf: f.input.asOf,
      inferenceCalls: [],
      inferenceTariff: Result.getOrThrow(
        registeredReplayInferenceTariff(
          prepared.definition.inferenceRateCard,
          { startAt: windows[0]!.openAt, endAt: windows.at(-1)!.closeAt },
          JevResearchPolicy.Deployed,
        ),
      ),
      sessions: policy.sessions.map((session) => ({ ...session.operatingCosts, trading: null })),
    },
  }
}
beforeAll(async () => {
  fixture = await frozenControlReplayFixture()
  prepared = Result.getOrThrow(prepareFrozenControlReplay(fixture.input, fixture.capture, fixture.captureHash))
  report = makeReport(prepared)
  costs = makeCosts(prepared)
  sources = costs.sources
}, 30000)

test('the original-control branch retains all twenty zero-trade operating losses without inventing execution assurance', () => {
  const value = Result.getOrThrowWith(
    reproduceFrozenControlReport(prepared, seal(report), costs.costs, sources),
    (cause) => cause,
  )
  expect(value.economics?.complete).toBe(true)
  expect(value.economics?.sessions).toHaveLength(20)
  expect(
    value.economics?.sessions.every(
      (session) => session.executionPnlMicros === '0' && BigInt(session.qualificationPnlMicros ?? '0') < 0n,
    ),
  ).toBe(true)
  const artifacts = new Map<string, Uint8Array>()
  const retain = (text: string) => {
    const hash = sha256(text)
    artifacts.set(hash, new TextEncoder().encode(text))
    sources.add(hash)
    return hash
  }
  sources.add(fixture.input.backtest.source.dataSha256)
  const descriptor = {
    policy: JevResearchPolicy.Deployed,
    inputFileHash: retain(JSON.stringify(fixture.input)),
    captureFileHash: retain(fixture.capture),
    reportFileHash: retain(JSON.stringify(seal(report))),
    costsFileHash: retain(JSON.stringify(costs.costs)),
    imagePlatform: null,
    executionReceiptHash: null,
  }
  const bound = Result.getOrThrowWith(
    bindLatencyStressSources(
      [descriptor],
      prepared.stress.registration,
      fixture.input.latencyStress.sourceCut,
      artifacts,
      sources,
    ),
    (cause) => cause,
  )
  expect(bound).toHaveLength(1)
  expect(bound[0]?.policy).toBe(JevResearchPolicy.Deployed)
  expect(bound[0]?.economics).toBeNull()
  expect(bound[0]?.executionReceiptHash).toBeNull()
})

test('resealing cannot hide a changed opening balance, missing session, unresolved reconciliation, altered calibration or unposted fee', () => {
  for (const changed of [
    { ...report, frozenLatency: { ...report.frozenLatency, p95FullBatchMs: report.frozenLatency.p95FullBatchMs + 1 } },
    {
      ...report,
      frozenLatency: {
        ...report.frozenLatency,
        opening: {
          ...report.frozenLatency.opening,
          state: {
            ...report.frozenLatency.opening.state,
            ledger: { ...report.brokerState.ledger, cashMicros: '100000000001' },
          },
        },
      },
    },
    { ...report, sessions: report.sessions.slice(1) },
    { ...report, accountingEvidence: { ...report.accountingEvidence, fees: ['{}'] } },
  ])
    expect(Result.isFailure(reproduceFrozenControlReport(prepared, seal(changed), costs.costs, sources))).toBe(true)
  const unresolved = {
    ...report,
    sessions: report.sessions.map((session, index) =>
      index === 0
        ? { ...session, reconciliation: { ...session.reconciliation, riskContext: { unknownMutationCount: 1 } } }
        : session,
    ),
  }
  expect(
    Result.getOrThrow(reproduceFrozenControlReport(prepared, seal(unresolved), costs.costs, sources)).economics,
  ).toBeNull()
  expect(
    Result.isFailure(
      reproduceFrozenControlReport(
        prepared,
        { ...seal(report), runId: testHash('replaced run') },
        costs.costs,
        sources,
      ),
    ),
  ).toBe(true)
})

test('PostgreSQL numeric tokens retain exact unsigned-128 identities and reject noninteger amounts', () => {
  expect(
    Result.getOrThrow(decodeFrozenAccountingRow('{"id":238242004234284789331416766542801493109,"cash":-9996980000}')),
  ).toEqual({ id: '238242004234284789331416766542801493109', cash: '-9996980000' })
  for (const text of ['{"cash":1.1}', '{"cash":1e9}', '{bad json}'])
    expect(Result.isFailure(decodeFrozenAccountingRow(text))).toBe(true)
})

const partialMarketEpisode = () => {
  const window = prepared.stress.registration.calendar.sessions[0]!
  const commit = (body: Record<string, unknown>) => ({ ...body, contentHash: testHash(body) })
  const ids = [testHash('partial entry'), testHash('market liquidation')]
  const issued = [Date.parse(window.openAt) + 31 * 60000, Date.parse(window.closeAt) - 10000]
  const at = (ms: number) => new Date(ms).toISOString()
  const releases = issued.map((start, index) => ({
    kind: index === 0 ? 'DECISION' : 'CLOSE',
    decisionHash: '',
    decisionAt: at(start),
    commandIssuedAt: at(start),
    completedAt: at(start + 1),
    releaseFloorAt: at(start + prepared.stress.p95FullBatchMs),
    releasedAt: at(start + Math.max(1, prepared.stress.p95FullBatchMs)),
  }))
  const documents = ids.map((id, index) =>
    commit({
      createdAt: at(issued[index]!),
      expiresAt: window.closeAt,
      submissionCutoffAt: window.closeAt,
      orderedIntentIds: [id],
    }),
  )
  const closing = commit({ createdAt: at(issued[1]!), document: documents[1] })
  releases[0]!.decisionHash = documents[0]!.contentHash
  releases[1]!.decisionHash = closing.contentHash
  let ledger = Result.getOrThrow(
    createReplayLedger<
      (typeof FrozenControlReportSchema.Type)['brokerState']['ledger']['fills'][number] & { quantityAtoms: string }
    >(prepared.input.backtest.openingCashMicros),
  )
  const rows = [],
    activities = [],
    charges = [],
    transactions = [],
    postings = [],
    fees = []
  const accountId = report.brokerState.accountId
  for (let index = 0; index < 2; index++) {
    const buy = index === 0
    const side = buy ? 'buy' : 'sell'
    const brokerOrderId = `synthetic-${index}`
    const clientOrderId = `b1_${Buffer.from(ids[index]!, 'hex').toString('base64url')}`
    const observedAt = releases[index]!.releasedAt
    const priceMicros = buy ? '100000000' : '101000000'
    const fill: (typeof ledger.fills)[number] = {
      brokerOrderId,
      clientOrderId,
      symbol: 'AAPL',
      side,
      observedAt,
      quantityMicros: '1000000',
      quantityAtoms: frozenQuantityAtoms(1000000n).toString(),
      priceMicros,
      notionalMicros: priceMicros,
      quoteSource: {
        topic: prepared.input.backtest.source.universe.topics.quotes,
        partition: 0,
        offset: String(index),
        availableAtMs: Date.parse(observedAt),
      },
    }
    const previousFee = BigInt(ledger.executionFeesMicros)
    ledger = Result.getOrThrow(
      applyReplayFill(
        ledger,
        fill,
        fill.quantityAtoms,
        prepared.protocol.executionModel,
        prepared.input.backtest.assumptions.feeMultiplierPpm,
      ),
    )
    const charge = BigInt(ledger.executionFeesMicros) - previousFee
    const order = {
      brokerOrderId,
      clientOrderId,
      accountId,
      symbol: 'AAPL',
      side,
      status: buy ? 'canceled' : 'filled',
      quantityMicros: buy ? '2000000' : '1000000',
      filledQuantityMicros: '1000000',
      ...(buy ? { limitPriceMicros: priceMicros } : {}),
      submittedAt: observedAt,
      updatedAt: observedAt,
      orderClass: 'simple',
      orderType: buy ? 'limit' : 'market',
      timeInForce: buy ? 'ioc' : 'day',
      extendedHours: false,
    }
    rows.push({
      order,
      execution: {
        submittedAt: observedAt,
        arrivedAt: observedAt,
        quote: {
          symbol: 'AAPL',
          askPrice: buy ? 100 : 101.01,
          bidPrice: buy ? 99.99 : 101,
          askSize: 100,
          bidSize: 100,
          availableAtMs: Date.parse(observedAt),
          sourceTopic: fill.quoteSource.topic,
          sourcePartition: 0,
          sourceOffset: String(index),
        },
        outcome: { status: 'filled' },
      },
    })
    activities.push({
      activityId: `fill::${brokerOrderId}`,
      brokerOrderId,
      accountId,
      symbol: 'AAPL',
      side,
      transactionTime: observedAt,
      quantityMicros: '1000000',
      priceMicros,
      cumulativeQuantityMicros: '1000000',
      leavesQuantityMicros: buy ? '1000000' : '0',
    })
    const activityId = `fee::${brokerOrderId}`
    charges.push({ activityId, accountId, date: window.sessionDate, netAmountMicros: (-charge).toString() })
    fees.push(
      JSON.stringify({
        activity_id: activityId,
        account_id: accountId,
        net_amount_micros: (-charge).toString(),
        posted_at: observedAt,
      }),
    )
    const brokerEvent = testHash({ index })
    transactions.push(
      JSON.stringify({
        transaction_id: testHash({ transaction: index }),
        broker_event_id: brokerEvent,
        intent_id: ids[index],
        account_id: accountId,
        symbol: 'AAPL',
        side: side.toUpperCase(),
        quantity_micros: '1000000',
        price_micros: priceMicros,
        notional_micros: priceMicros,
        fee_micros: '0',
        cash_delta_micros: (buy ? -BigInt(priceMicros) : BigInt(priceMicros)).toString(),
        realized_pnl_micros: buy ? '0' : '1000000',
        occurred_at: observedAt,
      }),
    )
    postings.push(
      JSON.stringify({
        broker_event_id: brokerEvent,
        intent_id: ids[index],
        debit_micros: priceMicros,
        credit_micros: priceMicros,
        account_ids: ['1', '2'],
        transfer_ids: [String(index + 1)],
        recorded_at: observedAt,
      }),
    )
  }
  const sessionCloses = report.brokerState.sessionCloses.map((close) => ({ ...close, equityMicros: ledger.cashMicros }))
  return {
    ...report,
    decisions: [documents[0]],
    closingDecisions: [closing],
    frozenLatency: { ...report.frozenLatency, receipts: releases },
    brokerState: {
      ...report.brokerState,
      ledger: { ...ledger, fills: ledger.fills.map(({ quantityAtoms: _quantity, ...fill }) => fill) },
      orders: rows,
      fills: activities,
      fees: charges,
      sessionCloses,
    },
    sessions: report.sessions.map((session) => ({
      ...session,
      closingEquity: { ...session.closingEquity, equityMicros: ledger.cashMicros },
    })),
    accountingEvidence: { ...report.accountingEvidence, transactions, receipts: postings, fees },
  }
}

test('frozen financial reproduction retains a partial IOC fill and an admissible close-only MARKET/DAY sell', () => {
  const trading = partialMarketEpisode()
  const value = Result.getOrThrowWith(
    reproduceFrozenControlReport(prepared, seal(trading), costs.costs, sources),
    (cause) => cause,
  )
  expect(value.economics?.complete).toBe(true)
  expect(value.economics?.sessions[0]?.executionPnlMicros).toBe('970000')
  expect(value.economics?.sessions.slice(1).every((session) => session.executionPnlMicros === '0')).toBe(true)
  expect(BigInt(value.economics?.sessions[0]?.qualificationPnlMicros ?? '0')).toBeLessThan(0n)
  for (const changed of [{ side: 'buy' }, { timeInForce: 'ioc' }, { limitPriceMicros: '101000000' }]) {
    const orders = trading.brokerState.orders.map((row, index) =>
      index === 1 ? { ...row, order: { ...row.order, ...changed } } : row,
    )
    expect(
      Result.isFailure(
        reproduceFrozenControlReport(
          prepared,
          seal({ ...trading, brokerState: { ...trading.brokerState, orders } }),
          costs.costs,
          sources,
        ),
      ),
    ).toBe(true)
  }
  const orders = trading.brokerState.orders.map((row, index) =>
    index === 1 ? { ...row, execution: { ...row.execution, quote: { ...row.execution.quote, bidSize: 0 } } } : row,
  )
  expect(
    Result.isFailure(
      reproduceFrozenControlReport(
        prepared,
        seal({ ...trading, brokerState: { ...trading.brokerState, orders } }),
        costs.costs,
        sources,
      ),
    ),
  ).toBe(true)
})
