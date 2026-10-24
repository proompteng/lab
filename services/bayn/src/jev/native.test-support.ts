import { jevPositionExitPolicy } from './exit-policy'
import { jevEntryEconomics, fundJevTradePlan } from './entry-economics'
import { JevEntrySetup } from './trade-plan-choices'
import { makeJevTradingSignalRequest } from './trading-signals'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { equityMarketProfile, jevHoldingMinutesForSymbol } from './markets'
import { exchangeSessions } from '../market-hours'
import { Result, Schema } from 'effect'
import { IsoDateSchema } from '../schemas'

import {
  AccountStatus,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
  type Fill,
  type Position,
  type Order,
} from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { streamingFixture, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { makeJevObservation } from './observation'
import { decodeJevPortfolio, JevPurpose } from './portfolio'
import { decodeJevProtocol, defaultJevProtocolDocument } from './protocol'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { makeStrategyProtocolHashResult } from '../contracts'
import { jevBehaviorHash } from './protocol'
import { prepareJevRequest, decodeJevResponse, type JevResponse } from './contract'
import {
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
} from './batch'
import { JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { makeJevTradingSignalBatch } from './trading-signals'
import { jevHistoryStartMs } from './observation-query'

export const nativeJevFixture = (
  purpose: JevPurpose = JevPurpose.Entry,
  observedAt?: string,
  accountId = 'jev-native-test',
  protocolDocument: unknown = defaultJevProtocolDocument,
  cycleBindingId = 'a'.repeat(64),
  returns: Readonly<Record<string, number>> = { AAPL: 0.02, AMZN: 0.01 },
  calendar?: ReturnType<typeof streamingFixture>['query']['calendar'],
  observedPriceChoices = true,
) => {
  const base = streamingFixture()
  const protocol = Result.getOrThrow(decodeJevProtocol(protocolDocument))
  const selectedCalendar = calendar ?? base.query.calendar
  const selectedDate = Schema.decodeUnknownSync(IsoDateSchema)(
    calendar === undefined ? base.query.sessionDate : (exchangeSessions(calendar)[0]?.date ?? base.query.sessionDate),
  )
  const end =
    Math.floor((Date.parse(observedAt ?? base.query.observedAt) - protocol.decisionDelaySeconds * 1000) / 60_000) *
    60_000
  const timedQuery = {
    ...base.query,
    calendar: selectedCalendar,
    sessionDate: selectedDate,
    ...(protocol.candidateEvidencePolicy === undefined
      ? {}
      : { candidateEvidencePolicy: protocol.candidateEvidencePolicy }),
    observedAt: observedAt ?? base.query.observedAt,
    rangeStartAt: new Date(
      jevHistoryStartMs(selectedCalendar, selectedDate, end, protocol.lookbackMinutes),
    ).toISOString(),
    rangeEndAt: new Date(end).toISOString(),
  }
  const query =
    purpose === JevPurpose.Entry
      ? {
          ...timedQuery,
          symbols: [
            ...protocol.candidateSymbols.filter((symbol) =>
              equityMarketProfile.candidateSymbols.some((candidate) => candidate === symbol),
            ),
            'SPY',
          ].sort(),
          candidateSymbols: protocol.candidateSymbols.filter((symbol) =>
            equityMarketProfile.candidateSymbols.some((candidate) => candidate === symbol),
          ),
        }
      : { ...timedQuery, symbols: ['AAPL', 'SPY'], candidateSymbols: ['AAPL'] }
  const {
    cut,
    query: snapshotQuery,
    snapshot,
  } = streamingFixtureFromRaw(
    (() => {
      const raw = makeIntradayMomentumTestSnapshot(
        protocol,
        { ...query, archiveWatermarks: base.archive.manifest.archiveWatermarks },
        returns,
      )
      const firstMinute = raw.bars[0]?.eventAt
      return {
        ...raw,
        bars: raw.bars.map((bar) =>
          observedPriceChoices && bar.symbol !== 'SPY' && bar.eventAt === firstMinute
            ? { ...bar, high: Math.max(bar.high, bar.open * 1.05), low: Math.min(bar.low, bar.open * 0.95) }
            : bar,
        ),
      }
    })(),
    query,
  )
  const at = snapshot.manifest.observedAt
  const intentId = 'c'.repeat(64)
  const positions: Position[] =
    purpose === JevPurpose.Entry
      ? []
      : [
          {
            schemaVersion: 'bayn.position.v2',
            accountId,
            symbol: 'AAPL',
            quantityAtoms: '5000000000',
            averageEntryPriceMicros: '100000000',
            costBasisMicros: '500000000',
            marketPriceMicros: '102000000',
            marketValueMicros: '510000000',
            unrealizedPnlMicros: '10000000',
            observedAt: at,
          },
        ]
  const orders: Order[] =
    purpose === JevPurpose.Entry
      ? []
      : [
          {
            schemaVersion: 'bayn.order.v3',
            accountId,
            brokerOrderId: 'entry-order',
            clientOrderId: 'entry-client',
            intentId,
            symbol: 'AAPL',
            side: OrderSide.Buy,
            orderType: OrderType.Limit,
            timeInForce: TimeInForce.ImmediateOrCancel,
            quantityAtoms: '10000000000',
            filledQuantityAtoms: '5000000000',
            limitPriceMicros: '100000000',
            status: OrderStatus.Canceled,
            observedAt: at,
          },
        ]
  const entryFills: Fill[] = [3, 2].map((quantity, index) => ({
    schemaVersion: 'bayn.fill.v2',
    accountId,
    fillId: `fill-${index}`,
    brokerOrderId: 'entry-order',
    clientOrderId: 'entry-client',
    intentId,
    symbol: 'AAPL',
    side: OrderSide.Buy,
    quantityAtoms: String(quantity * 1_000_000_000),
    priceAtoms: '100000000000',
    feeMicros: '0',
    occurredAt: new Date(Date.parse(at) - 3 * 60_000).toISOString(),
  }))
  const material = {
    account: {
      schemaVersion: 'bayn.paper-account-snapshot.v1' as const,
      accountId,
      status: AccountStatus.Active,
      currency: 'USD' as const,
      cashMicros: '99500000000',
      equityMicros: '100010000000',
      buyingPowerMicros: '99500000000',
      observedAt: at,
    },
    positions,
    positionsObservedAt: at,
    orders,
    ordersObservedAt: at,
    accountingHash: 'd'.repeat(64),
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(material))
  const brokerState = {
    ...material,
    unknownOrderCount: 0,
    reconciliation: {
      schemaVersion: 'bayn.paper-reconciliation.v1' as const,
      reconciliationId: 'e'.repeat(64),
      accountId,
      expectedHash: stateHash,
      observedHash: stateHash,
      contentHash: Result.getOrThrow(canonicalHashV1Result(material)),
      status: ReconciliationStatus.Exact,
      discrepancies: [],
      reconciledAt: at,
    },
  }
  const portfolio = Result.getOrThrow(
    decodeJevPortfolio(
      purpose === JevPurpose.Entry
        ? { purpose, brokerState }
        : {
            purpose,
            brokerState,
            entryDecisionHash: 'f'.repeat(64),
            exitPolicy: (() => {
              const economics = Result.getOrThrow(
                jevEntryEconomics({
                  protocol,
                  symbol: 'AAPL',
                  bidMicros: 102_000_000n,
                  askMicros: 102_010_000n,
                  capitalMicros: material.account.equityMicros,
                }),
              )
              if (economics === null) throw new Error('Managed fixture requires a funded pre-entry plan')
              const funded = Result.getOrThrow(
                fundJevTradePlan({
                  protocol,
                  economics,
                  levels: {
                    schemaVersion: 'bayn.jev-strategy-exit-plan.v3',
                    rule: 'model-selected-complete-plan',
                    symbol: 'AAPL',
                    sourceStartAt: new Date(Date.parse(at) - 30 * 60000).toISOString(),
                    sourceEndAt: new Date(Date.parse(at) - 3 * 60000).toISOString(),
                    maximumHoldingMinutes: jevHoldingMinutesForSymbol(protocol, 'AAPL'),
                    maximumEntryPriceMicros: economics.maximumEntryPriceMicros,
                    stopPriceMicros: '99000000',
                    stopLimitPriceMicros: '98910000',
                    profitLimitPriceMicros: '105000000',
                  },
                }),
              )
              if (funded === null) throw new Error('Managed fixture requires funded model prices')
              return jevPositionExitPolicy({ AAPL: funded.exitPlan })
            })(),
            entryIntentIds: [intentId],
            protectionIntentIds: [],
            exitRequestedAt: null,
            profitExitRequested: false,
            entryFills,
            entryInventoryDebit: { quantityAtoms: '0', costBasisMicros: '0' },
            protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' },
          },
    ),
  )
  const session = exchangeSessions(snapshot.manifest.calendar)[0]
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
  if (session === undefined || executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
    throw new Error('Native fixture requires an intraday session')
  const draft = Result.getOrThrow(
    makeIntradayCycleDraft(
      {
        cycleBindingId,
        strategyName: 'jev',
        strategyProtocolHash: Result.getOrThrow(
          makeStrategyProtocolHashResult({
            name: 'jev',
            behaviorHash: jevBehaviorHash,
            parameterHash: Result.getOrThrow(canonicalHashV1Result(protocol)),
            parameterSchemaVersion: protocol.schemaVersion,
          }),
        ),
        accountId,
        executionPolicy,
      },
      snapshot.manifest.calendar,
      session,
    ),
  )
  const input = {
    cycleId: draft.identity.cycleId,
    authorityGenerationHash: 'b'.repeat(64),
    protocol,
    portfolio,
    snapshot,
  }
  const observation = Result.getOrThrow(makeJevObservation(input))

  return { protocol, portfolio, observation, snapshot, cut, query: snapshotQuery, entryFills, draft, input }
}

export const nativeJevInference = (input: unknown, at: string, action = 'enter', probability = 0.8) => {
  const { request, requestHash } = Result.getOrThrow(prepareJevRequest(input))
  const answers: Record<string, JevResponse['answers'][string]> = {}
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') answers[key] = { type: 'noul', noul: 0.8 }
    else if (question.type === 'choice') {
      const choices = Object.keys(question.criteria)
      const selected =
        key === 'setup'
          ? JevEntrySetup.Upward
          : key === 'action' && action === 'enter'
            ? (choices.find((choice) => choice.startsWith('plan_')) ?? 'wait')
            : key === 'action'
              ? action
              : choices[0]
      const choiceProbability = key === 'action' || key === 'setup' ? probability : 0.8
      if (selected === undefined || !choices.includes(selected)) throw new Error('Invalid fixture choice')
      answers[key] = {
        type: 'choice',
        choice: selected,
        confidence: choiceProbability,
        probabilities: Object.fromEntries(
          choices.map((choice) => [
            choice,
            choice === selected ? choiceProbability : (1 - choiceProbability) / (choices.length - 1),
          ]),
        ),
      }
    } else {
      answers[key] = {
        type: 'score',
        score: 0,
        confidence: 1,
        probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 0 ? 1 : 0])),
        legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
      }
    }
  }
  const response = Result.getOrThrow(
    decodeJevResponse(request, { model: request.model, answers, usage: { input_tokens: 100, output_tokens: 25 } }),
  )
  return {
    requestHash,
    responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
    startedAt: at,
    completedAt: at,
    response,
  }
}

export const nativeJevDecisionEvidence = (
  fixture: Pick<ReturnType<typeof nativeJevFixture>, 'observation' | 'protocol'> = nativeJevFixture(),
  action = 'enter',
  probability = 0.8,
) => {
  const observation = fixture.observation.payload
  const at = new Date(Date.parse(observation.observedAt) + 100).toISOString()
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observation.observedAt) + fixture.protocol.inferenceValidityMs).toISOString(),
      planVersion: JevBatchPlanVersion.V6,
    }),
  )
  const batchResult = nativeJevBatchResult(batchPlan, at, () => action, probability)
  return { observation, batchPlan, batchResult, decidedAt: at }
}

export const nativeJevBatchResult = (
  batchPlan: JevBatchPlan,
  at: string,
  action: (symbol: string) => string = () => 'enter',
  probability = 0.8,
) =>
  Result.getOrThrow(
    makeJevBatchResult(batchPlan, {
      schemaVersion: 'bayn.jev-batch-result.v1',
      batchId: batchPlan.batchId,
      completedAt: at,
      candidates: batchPlan.candidates.map((candidate) => {
        if (candidate.status === JevCandidatePlanStatus.Excluded)
          return { status: JevCandidateResultStatus.Excluded, symbol: candidate.symbol }
        const receipt = Result.getOrThrow(
          makeJevEvaluationReceipt(candidate.request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v1',
            requestId: candidate.request.requestId,
            startedAt: at,
            completedAt: at,
            outcome: {
              status: JevOutcome.Received,
              inference: nativeJevInference(candidate.request.request, at, action(candidate.symbol), probability),
            },
          }),
        )
        const resolution = Result.getOrThrow(
          makeJevResolution(candidate.request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: candidate.request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        )
        return {
          status: JevCandidateResultStatus.Resolved,
          symbol: candidate.symbol,
          requestId: candidate.request.requestId,
          receipt,
          resolution,
        }
      }),
    }),
  )

export const jevObservationForSnapshot = (snapshot: VerifiedStrategyMarketSnapshot) =>
  Result.gen(function* () {
    const prior = nativeJevFixture().portfolio.brokerState
    const observedAt = snapshot.manifest.observedAt
    const material = {
      account: { ...prior.account, observedAt },
      positions: [],
      orders: [],
      positionsObservedAt: observedAt,
      ordersObservedAt: observedAt,
      accountingHash: prior.accountingHash,
    }
    const hash = yield* reconciledStateHash(material)
    const portfolio = yield* decodeJevPortfolio({
      purpose: JevPurpose.Entry,
      brokerState: {
        ...material,
        unknownOrderCount: 0,
        reconciliation: { ...prior.reconciliation, reconciledAt: observedAt, expectedHash: hash, observedHash: hash },
      },
    })
    const { candidateEvidencePolicy: _policy, ...parameters } = defaultJevProtocolDocument
    const protocol = yield* decodeJevProtocol({
      ...parameters,
      maximumQuoteAgeMs: snapshot.manifest.maximumQuoteAgeMs,
      ...(snapshot.manifest.candidateEvidencePolicy === undefined
        ? {}
        : { candidateEvidencePolicy: snapshot.manifest.candidateEvidencePolicy }),
    })
    return yield* makeJevObservation({
      cycleId: 'a'.repeat(64),
      authorityGenerationHash: 'b'.repeat(64),
      protocol,
      portfolio,
      snapshot,
    })
  })

export const jevRequestForSnapshot = (snapshot: VerifiedStrategyMarketSnapshot, symbol: string) =>
  jevObservationForSnapshot(snapshot).pipe(
    Result.flatMap((observation) => makeJevTradingSignalRequest(observation.payload, symbol)),
  )
