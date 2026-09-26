import { Result } from 'effect'

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
import { canonicalHashV1 } from '../hash'
import { reconciledStateHash } from '../reconciliation'
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

export const nativeJevFixture = (
  purpose: JevPurpose = JevPurpose.Entry,
  observedAt?: string,
  accountId = 'jev-native-test',
) => {
  const base = streamingFixture()
  const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
  const end =
    Math.floor((Date.parse(observedAt ?? base.query.observedAt) - protocol.decisionDelaySeconds * 1000) / 60_000) *
    60_000
  const timedQuery = {
    ...base.query,
    ...(protocol.candidateEvidencePolicy === undefined
      ? {}
      : { candidateEvidencePolicy: protocol.candidateEvidencePolicy }),
    observedAt: observedAt ?? base.query.observedAt,
    rangeStartAt: new Date(end - protocol.lookbackMinutes * 60_000).toISOString(),
    rangeEndAt: new Date(end).toISOString(),
  }
  const query =
    purpose === JevPurpose.Entry
      ? {
          ...timedQuery,
          symbols: [...protocol.candidateSymbols, 'SPY'].sort(),
          candidateSymbols: protocol.candidateSymbols,
        }
      : { ...timedQuery, symbols: ['AAPL', 'SPY'], candidateSymbols: ['AAPL'] }
  const {
    cut,
    query: snapshotQuery,
    snapshot,
  } = streamingFixtureFromRaw(
    makeIntradayMomentumTestSnapshot(
      protocol,
      { ...query, archiveWatermarks: base.archive.manifest.archiveWatermarks },
      { AAPL: 0.02, AMZN: 0.01 },
    ),
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
            quantityMicros: '5000000',
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
            schemaVersion: 'bayn.paper-order.v1',
            accountId,
            brokerOrderId: 'entry-order',
            clientOrderId: 'entry-client',
            intentId,
            symbol: 'AAPL',
            side: OrderSide.Buy,
            orderType: OrderType.Limit,
            timeInForce: TimeInForce.ImmediateOrCancel,
            quantityMicros: '10000000',
            filledQuantityMicros: '5000000',
            limitPriceMicros: '100000000',
            status: OrderStatus.Canceled,
            observedAt: at,
          },
        ]
  const entryFills: Fill[] = [3, 2].map((quantity, index) => ({
    schemaVersion: 'bayn.paper-fill.v1',
    accountId,
    fillId: `fill-${index}`,
    brokerOrderId: 'entry-order',
    clientOrderId: 'entry-client',
    intentId,
    symbol: 'AAPL',
    side: OrderSide.Buy,
    quantityMicros: String(quantity * 1_000_000),
    priceMicros: '100000000',
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
      contentHash: canonicalHashV1(material),
      status: ReconciliationStatus.Exact,
      discrepancies: [],
      reconciledAt: at,
    },
  }
  const portfolio = Result.getOrThrow(
    decodeJevPortfolio(
      purpose === JevPurpose.Entry
        ? { purpose, brokerState }
        : { purpose, brokerState, entryDecisionHash: 'f'.repeat(64), entryIntentIds: [intentId], entryFills },
    ),
  )
  const session = snapshot.manifest.calendar.sessions[0]
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
  if (session === undefined || executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
    throw new Error('Native fixture requires an intraday session')
  const draft = Result.getOrThrow(
    makeIntradayCycleDraft(
      {
        cycleBindingId: 'a'.repeat(64),
        strategyName: 'jev',
        strategyProtocolHash: Result.getOrThrow(
          makeStrategyProtocolHashResult({
            name: 'jev',
            behaviorHash: jevBehaviorHash,
            parameterHash: canonicalHashV1(protocol),
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
  const observation = Result.getOrThrow(
    makeJevObservation({
      cycleId: draft.identity.cycleId,
      authorityGenerationHash: 'b'.repeat(64),
      protocol,
      portfolio,
      snapshot,
    }),
  )
  return { protocol, portfolio, observation, snapshot, cut, query: snapshotQuery, entryFills, draft }
}

export const nativeJevInference = (input: unknown, at: string, action = 'enter', probability = 0.8) => {
  const { request, requestHash } = Result.getOrThrow(prepareJevRequest(input))
  const answers: Record<string, JevResponse['answers'][string]> = {}
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') answers[key] = { type: 'noul', noul: 0.8 }
    else if (question.type === 'choice') {
      const choices = Object.keys(question.criteria)
      const selected = key === 'action' ? action : choices[0]
      if (selected === undefined || !choices.includes(selected)) throw new Error('Invalid fixture choice')
      answers[key] = {
        type: 'choice',
        choice: selected,
        confidence: probability,
        probabilities: Object.fromEntries(
          choices.map((choice) => [
            choice,
            choice === selected ? probability : (1 - probability) / (choices.length - 1),
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
  return { requestHash, responseHash: canonicalHashV1(response), startedAt: at, completedAt: at, response }
}

export const nativeJevDecisionEvidence = (fixture = nativeJevFixture(), action = 'enter', probability = 0.8) => {
  const observation = fixture.observation.payload
  const at = new Date(Date.parse(observation.observedAt) + 100).toISOString()
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observation.observedAt) + fixture.protocol.inferenceValidityMs).toISOString(),
      planVersion: JevBatchPlanVersion.V1,
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
