import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { JevBatchPlanVersion, JevCandidatePlanStatus, JevCandidateResultStatus, decodeJevBatchPlan } from './batch'
import { jevEntryEconomics, jevMaximumEntryAskMicros } from './entry-economics'
import { jevLiquidationValue } from './liquidation-economics'
import { prepareEntryInferenceInput } from './entry-inference-input'
import { stagedCheckpointFixture, entryCompletionFixture } from './entry-inference.test-support'
import { nativeJevFixture, nativeJevDecisionEvidence } from './native.test-support'
import { decodeJevEvaluationRequest, JevOutcome } from './evidence'
import { makeJevResolution, JevResolutionStatus } from './resolution'
import { verifyJevStudyExportRow } from './study-export'
import { prepareSignalStudyBatch } from '../intraday-replay/signal-study'
import {
  decodeJevProtocol,
  defaultJevProtocolDocument,
  HistoricalJevProtocolSchema,
  RetainedJevProtocolV38Schema,
} from './protocol'
import {
  reconstructRetainedJevV38TradingSignalBatch,
  reproduceRetainedJevV38RequestFromObservation,
  reproduceRetainedJevV38TradingSignalBatchEvidence,
} from './retained-v38-trading-signals'
import { retainedV38TradingSignalGolden } from './retained-v38-trading-signals.test-support'
import { makeJevTradingSignalBatch } from './trading-signals'
import { readStagedInferenceCostEvidence } from './staged-inference-cost-evidence'

const retainedProtocol = Schema.decodeUnknownSync(RetainedJevProtocolV38Schema)({
  ...defaultJevProtocolDocument,
  schemaVersion: 'bayn.jev.protocol.v38',
})
const fixture = () => {
  const current = nativeJevFixture().observation.payload
  const observation = { ...current, cycleId: 'a'.repeat(64), protocol: retainedProtocol }
  return {
    current,
    observation,
    expiresAt: new Date(Date.parse(observation.observedAt) + 10_000).toISOString(),
  }
}

describe('v39 entry allowance semantics and immutable v38 evidence', () => {
  for (const golden of retainedV38TradingSignalGolden) {
    test(`retained ${golden.planVersion} reproduces every pre-cutover request byte and batch identity`, () => {
      const input = fixture()
      const plan = Result.getOrThrow(
        reconstructRetainedJevV38TradingSignalBatch({
          ...input,
          planVersion: Schema.decodeUnknownSync(Schema.Enum(JevBatchPlanVersion))(golden.planVersion),
        }),
      )
      const requests = plan.candidates.flatMap((candidate) => {
        if (candidate.status !== JevCandidatePlanStatus.Requested) return []
        const prepared = Result.getOrThrow(
          reproduceRetainedJevV38RequestFromObservation(candidate.request, input.observation),
        )
        expect(sha256(prepared.body)).toBe(candidate.request.requestHash)
        expect(prepared.input.numericalState['entryEconomics']).toMatchObject({
          maximumEntryQuoteDriftBps: 10,
          maximumEntryLimitSlippageBps: 10,
        })
        return [
          {
            symbol: candidate.symbol,
            requestId: candidate.request.requestId,
            requestHash: candidate.request.requestHash,
            bodyBytes: Buffer.byteLength(prepared.body),
          },
        ]
      })
      expect({
        planVersion: plan.schemaVersion,
        observationHash: plan.observationHash,
        protocolHash: plan.protocolHash,
        questionSetHash: plan.questionSetHash,
        batchId: plan.batchId,
        requests,
      }).toEqual({
        ...golden,
        planVersion: Schema.decodeUnknownSync(Schema.Enum(JevBatchPlanVersion))(golden.planVersion),
        requests: [...golden.requests],
      })
      expect(
        Result.getOrThrow(reproduceRetainedJevV38TradingSignalBatchEvidence(input.observation, structuredClone(plan))),
      ).toEqual(plan)
      expect(Result.isFailure(makeJevTradingSignalBatch({ ...input, planVersion: plan.schemaVersion }))).toBe(true)
      expect(Result.isFailure(decodeJevBatchPlan(plan))).toBe(true)
    })
  }

  test('retained v38 staged costs still verify their original request and provider claims', () => {
    const input = fixture()
    const plan = Result.getOrThrow(
      reconstructRetainedJevV38TradingSignalBatch({ ...input, planVersion: JevBatchPlanVersion.V8 }),
    )
    const candidate = plan.candidates.find((entry) => entry.status === JevCandidatePlanStatus.Requested)
    if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected a retained request')
    const result = Result.getOrThrow(
      readStagedInferenceCostEvidence({
        request: candidate.request,
        receipt: null,
        handoff: null,
        resolution: null,
        stagedCheckpoint: stagedCheckpointFixture(candidate.request),
      }),
    )
    expect(result.visualStages.map((stage) => stage.outcome)).toEqual(['RECEIVED', 'RECEIVED'])
    expect(result.request.requestHash).toBe(candidate.request.requestHash)
  })

  test('public study export and selection reproduce retained requests, receipts and results without current admission', () => {
    const input = fixture()
    const plan = Result.getOrThrow(
      reconstructRetainedJevV38TradingSignalBatch({ ...input, planVersion: JevBatchPlanVersion.V8 }),
    )
    const at = new Date(Date.parse(plan.observedAt) + 100).toISOString()
    const resultMaterial = {
      schemaVersion: 'bayn.jev-batch-result.v1' as const,
      batchId: plan.batchId,
      completedAt: at,
      candidates: plan.candidates.map((candidate) => {
        if (candidate.status === JevCandidatePlanStatus.Excluded)
          return { status: JevCandidateResultStatus.Excluded as const, symbol: candidate.symbol }
        const material = {
          schemaVersion: 'bayn.jev-evaluation-receipt.v3' as const,
          requestId: candidate.request.requestId,
          startedAt: at,
          completedAt: at,
          outcome: { status: JevOutcome.Completed as const, completion: entryCompletionFixture(candidate.request, at) },
        }
        const receipt = { ...material, receiptHash: Result.getOrThrow(canonicalHashV1Result(material)) }
        const resolution = Result.getOrThrow(
          makeJevResolution(candidate.request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: candidate.request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        )
        expect(Result.isFailure(decodeJevEvaluationRequest(candidate.request))).toBe(true)
        return {
          status: JevCandidateResultStatus.Resolved as const,
          symbol: candidate.symbol,
          requestId: candidate.request.requestId,
          receipt,
          resolution,
        }
      }),
    }
    const result = { ...resultMaterial, resultHash: Result.getOrThrow(canonicalHashV1Result(resultMaterial)) }
    const row = {
      batchId: plan.batchId,
      cycleId: plan.cycleId,
      observationHash: plan.observationHash,
      observation: input.observation,
      plan,
      result,
    }
    const sessionDate = input.observation.manifest.sessionDate
    const accountId = input.observation.portfolio.brokerState.account.accountId
    const exported = Result.getOrThrow(verifyJevStudyExportRow(row, sessionDate, accountId))
    expect(exported.plan).toEqual(plan)
    expect(exported.result).toEqual(result)
    const study = Result.getOrThrow(
      prepareSignalStudyBatch({
        observation: row.observation,
        batchPlan: row.plan,
        batchResult: row.result,
      }),
    )
    expect(study.modelStatus).toBe('AVAILABLE')
    const { decidedAt: _decidedAt, ...currentEvidence } = nativeJevDecisionEvidence()
    expect(study.selected).toEqual(Result.getOrThrow(prepareSignalStudyBatch(currentEvidence)).selected)
    let fundedComparisons = 0
    for (const prior of exported.result?.candidates ?? []) {
      const successor = currentEvidence.batchResult.candidates.find((entry) => entry.symbol === prior.symbol)
      if (
        prior.status !== JevCandidateResultStatus.Resolved ||
        prior.receipt?.outcome.status !== JevOutcome.Completed ||
        successor?.status !== JevCandidateResultStatus.Resolved ||
        successor.receipt?.outcome.status !== JevOutcome.Completed
      )
        continue
      const before = prior.receipt.outcome.completion.handoff.disposition
      const after = successor.receipt.outcome.completion.handoff.disposition
      if (before.status === 'READY' && after.status === 'READY') {
        // This includes proposal IDs, stops, targets, adverse stop prices, fees and exact funded quantities.
        expect(after.evaluation).toEqual(before.evaluation)
        fundedComparisons += 1
      }
    }
    expect(fundedComparisons).toBeGreaterThan(0)
    expect(
      Result.getOrThrow(verifyJevStudyExportRow({ ...row, result: null }, sessionDate, accountId)).result,
    ).toBeNull()
    for (const changed of [
      { ...row, observation: input.current },
      { ...row, result: { ...result, resultHash: 'f'.repeat(64) } },
      {
        ...row,
        observation: {
          ...input.observation,
          protocol: { ...retainedProtocol, schemaVersion: 'bayn.jev.protocol.v40' },
        },
      },
    ])
      expect(Result.isFailure(verifyJevStudyExportRow(changed, sessionDate, accountId))).toBe(true)
    // A valid hash cannot turn premature, unattempted work into a completed historical result.
    const premature = {
      ...resultMaterial,
      candidates: plan.candidates.map((candidate) =>
        candidate.status === JevCandidatePlanStatus.Excluded
          ? { status: JevCandidateResultStatus.Excluded, symbol: candidate.symbol }
          : {
              status: JevCandidateResultStatus.Unattempted,
              symbol: candidate.symbol,
              requestId: candidate.request.requestId,
            },
      ),
    }
    expect(
      Result.isFailure(
        verifyJevStudyExportRow(
          {
            ...row,
            result: { ...premature, resultHash: Result.getOrThrow(canonicalHashV1Result(premature)) },
          },
          sessionDate,
          accountId,
        ),
      ),
    ).toBe(true)
  })

  test('successor emits effective zero allowances while retaining shared exit settings and strict identity', () => {
    const input = fixture()
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: input.current,
        expiresAt: input.expiresAt,
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    expect(defaultJevProtocolDocument.schemaVersion).toBe('bayn.jev.protocol.v39')
    expect(defaultJevProtocolDocument.maximumEntryQuoteDriftBps).toBe(10)
    expect(defaultJevProtocolDocument.maximumEntryLimitSlippageBps).toBe(10)
    for (const candidate of plan.candidates) {
      if (candidate.status !== JevCandidatePlanStatus.Requested) continue
      expect(candidate.request.request.numericalState['entryEconomics']).toMatchObject({
        maximumEntryQuoteDriftBps: 0,
        maximumEntryLimitSlippageBps: 0,
      })
      const changed = structuredClone(candidate.request.request)
      Object.assign(changed.numericalState['entryEconomics'] ?? {}, { maximumEntryQuoteDriftBps: 10 })
      expect(Result.isFailure(prepareEntryInferenceInput(changed))).toBe(true)
    }
    expect(Result.isFailure(decodeJevProtocol(retainedProtocol))).toBe(true)
    expect(Result.getOrThrow(Schema.decodeUnknownResult(HistoricalJevProtocolSchema)(retainedProtocol))).toEqual(
      retainedProtocol,
    )
    for (const changed of [
      { ...defaultJevProtocolDocument, schemaVersion: 'bayn.jev.protocol.v40' },
      { ...defaultJevProtocolDocument, inputDefinition: 'bayn.jev-entry-state.v23' },
      { ...defaultJevProtocolDocument, maximumEntryQuoteDriftBps: 0 },
      { ...retainedProtocol, maximumEntryLimitSlippageBps: 0 },
    ]) {
      expect(Result.isFailure(decodeJevProtocol(changed))).toBe(true)
      expect(Result.isFailure(Schema.decodeUnknownResult(HistoricalJevProtocolSchema)(changed))).toBe(true)
    }
  })

  test('rehashing altered or mixed-version retained material cannot manufacture original evidence', () => {
    const input = fixture()
    const plan = Result.getOrThrow(
      reconstructRetainedJevV38TradingSignalBatch({ ...input, planVersion: JevBatchPlanVersion.V8 }),
    )
    const candidate = plan.candidates.find((entry) => entry.status === JevCandidatePlanStatus.Requested)
    if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected a retained request')
    const changedRequest = structuredClone(candidate.request)
    Object.assign(changedRequest.request.numericalState['entryEconomics'] ?? {}, { maximumEntryQuoteDriftBps: 0 })
    Object.assign(changedRequest, { requestHash: Result.getOrThrow(canonicalHashV1Result(changedRequest.request)) })
    const { requestId: _requestId, ...requestMaterial } = changedRequest
    Object.assign(changedRequest, { requestId: Result.getOrThrow(canonicalHashV1Result(requestMaterial)) })
    expect(Result.isFailure(reproduceRetainedJevV38RequestFromObservation(changedRequest, input.observation))).toBe(
      true,
    )
    expect(Result.isFailure(reproduceRetainedJevV38RequestFromObservation(candidate.request, input.current))).toBe(true)
    expect(Result.isFailure(reproduceRetainedJevV38TradingSignalBatchEvidence(input.current, plan))).toBe(true)

    const changedPlan = structuredClone(plan)
    Object.assign(changedPlan.candidates.find((entry) => entry.symbol === candidate.symbol) ?? {}, {
      request: changedRequest,
    })
    const { batchId: _batchId, ...planMaterial } = changedPlan
    Object.assign(changedPlan, { batchId: Result.getOrThrow(canonicalHashV1Result(planMaterial)) })
    expect(Result.isFailure(reproduceRetainedJevV38TradingSignalBatchEvidence(input.observation, changedPlan))).toBe(
      true,
    )
    expect(
      Result.isFailure(
        reconstructRetainedJevV38TradingSignalBatch({
          ...input,
          expiresAt: input.observation.observedAt,
          planVersion: JevBatchPlanVersion.V8,
        }),
      ),
    ).toBe(true)
  })

  test.each([
    { symbol: 'NVDA', askMicros: 10_201_000n, cryptoFeeTier: null },
    { symbol: 'AAPL', askMicros: 100_000_000n, cryptoFeeTier: null },
    { symbol: 'BTC/USD', askMicros: 80_000_000_001n, cryptoFeeTier: null },
    { symbol: 'BTC/USD', askMicros: 80_000_000_001n, cryptoFeeTier: 4 as const },
  ])(
    'entry price, sizing, dated fees, and exit economics remain identical for $symbol tier $cryptoFeeTier',
    (market) => {
      const input = {
        ...market,
        feeAt: '2026-11-06T15:00:00.000Z',
        bidMicros: market.askMicros - 1_000n,
        capitalMicros: '400000000000',
      }
      const prior = Result.getOrThrow(jevEntryEconomics({ ...input, protocol: retainedProtocol }))
      const successor = Result.getOrThrow(jevEntryEconomics({ ...input, protocol: defaultJevProtocolDocument }))
      expect(prior).not.toBeNull()
      if (prior === null) throw new Error('Expected funded economics')
      expect(successor).toEqual({ ...prior, maximumEntryQuoteDriftBps: 0, maximumEntryLimitSlippageBps: 0 })
      expect(jevMaximumEntryAskMicros(defaultJevProtocolDocument, market.symbol, market.askMicros)).toBe(
        jevMaximumEntryAskMicros(retainedProtocol, market.symbol, market.askMicros),
      )
      const liquidation = { ...input, quantityAtoms: BigInt(prior.receivedQuantityAtoms) }
      expect(Result.getOrThrow(jevLiquidationValue({ ...liquidation, protocol: defaultJevProtocolDocument }))).toEqual(
        Result.getOrThrow(jevLiquidationValue({ ...liquidation, protocol: retainedProtocol })),
      )
    },
  )
})
