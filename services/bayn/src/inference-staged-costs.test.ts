import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from './hash'
import {
  decodeInferenceCostEvidence,
  inferenceStageKey,
  InferenceStage,
  InferenceUsageStatus,
  makeInferenceCostReport,
} from './inference-costs'
import {
  buildInferenceExpensePlan,
  decodeInferenceExpenseQuote,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseCoverage,
  verifyInferenceExpenseQuote,
  type InferenceExpenseSource,
} from './inference-expense'
import { makeNativeChartEvidence } from './jev/chart-evidence'
import { type DecisionsRequest, type DecisionsResponse } from './jev/decisions'
import {
  entryEvaluationRequestFixture,
  entryCompletionFixture,
  stagedCheckpointFixture,
} from './jev/entry-inference.test-support'
import { makeJevEvaluationReceipt, JevOutcome } from './jev/evidence'
import { JevResolutionStatus, makeJevResolution } from './jev/resolution'
import { makeInitialChartStageRequest, makeSelectedBaseStartStageRequest } from './jev/staged-chart-questions'
import {
  makeStagedDispatchClaim,
  makeStagedTerminalReceipt,
  makeStagedSkipReceipt,
  type StagedCheckpoint,
} from './jev/staged-checkpoint'

const request = entryEvaluationRequestFixture()
const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
const chartSource = { chart, protocol: request.request.protocol, funding: request.request.funding }
const initial = Result.getOrThrow(makeInitialChartStageRequest(chartSource))
const responseFor = (prepared: DecisionsRequest, noBase = false): DecisionsResponse => ({
  model: prepared.model,
  answers: prepared.questions.map((question) => {
    if (question.type === 'predicate') return { type: 'predicate', name: question.name, probability: 0.8 }
    const choice =
      question.name === 'base_last_bar'
        ? noBase
          ? 'no_base'
          : question.choices.filter((item) => item.value !== 'no_base').at(-1)?.value
        : question.choices[0]?.value
    if (choice === undefined) throw new Error('Fixture requires an admissible choice')
    return {
      type: 'choice',
      name: question.name,
      choice,
      confidence: 0.8,
      probabilities: question.choices.map((item) => ({ value: item.value, probability: 1 / question.choices.length })),
    }
  }),
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
    output_tokens: 10,
    total_tokens: 110,
  },
})
const chartClaim = Result.getOrThrow(
  makeStagedDispatchClaim({
    schemaVersion: 'bayn.staged-dispatch-claim.v1',
    stage: 'CHART',
    requestId: request.requestId,
    providerRequestHash: initial.requestHash,
    predecessorHash: null,
    selectedEnd: null,
    claimedAt: request.observedAt,
    expiresAt: request.expiresAt,
  }),
)
const chartTerminalFor = (noBase = false) => {
  const response = responseFor(initial.request, noBase)
  return Result.getOrThrow(
    makeStagedTerminalReceipt({
      schemaVersion: 'bayn.staged-terminal-receipt.v1',
      stage: 'CHART',
      requestId: request.requestId,
      claimHash: chartClaim.claimHash,
      recordedAt: request.observedAt,
      outcome: {
        status: 'RECEIVED',
        inference: {
          requestHash: initial.requestHash,
          responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
          response,
          startedAt: request.observedAt,
          completedAt: request.observedAt,
        },
      },
    }),
  )
}
const source = (checkpoint: StagedCheckpoint): InferenceExpenseSource => ({
  accountId: 'staged-cost-test',
  sessionDate: '2026-10-25',
  asOf: '2026-10-25T07:01:00.000Z',
  requestId: request.requestId,
  cycleId: request.cycleId,
  authorityGenerationHash: request.authorityGenerationHash,
  request,
  receipt: null,
  resolution: null,
  handoff: null,
  stagedCheckpoint: checkpoint,
})
const quotes = (value: InferenceExpenseSource) =>
  Result.getOrThrow(makeInferenceExpenseQuotes(value, inferenceExpenseRateCard))
const rawEvidence = (value: InferenceExpenseSource) => {
  const { accountId, sessionDate, asOf, ...row } = value
  return {
    schemaVersion: 'bayn.inference-cost-evidence.v4',
    accountBindingHash: Result.getOrThrow(
      canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
    ),
    sessionDate,
    asOf,
    requests: [row],
  }
}
const evidence = (value: InferenceExpenseSource) => Result.getOrThrow(decodeInferenceCostEvidence(rawEvidence(value)))

test('late JEV receipt preserves a frozen abandoned READY prefix and charges once', () => {
  const checkpoint = stagedCheckpointFixture(request)
  const completion = entryCompletionFixture(request)
  expect(completion.handoff.disposition.status).toBe('READY')
  const resolution = Result.getOrThrow(
    makeJevResolution(request, null, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Abandoned,
      abandonedAt: request.expiresAt,
    }),
  )
  const before = { ...source(checkpoint), resolution, handoff: completion.handoff }
  const old = quotes(before)
  const unknown = old.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Jev)
  if (unknown === undefined) throw new Error('Expected frozen JEV quote')
  expect(unknown.line.usageStatus).toBe(InferenceUsageStatus.Unknown)
  expect(unknown.line.receiptHash).toBeNull()
  expect(unknown.line.resolutionHash).toBe(resolution.resolutionHash)
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v3',
      requestId: request.requestId,
      startedAt: request.observedAt,
      completedAt: completion.completedAt,
      outcome: { status: JevOutcome.Completed, completion },
    }),
  )
  const after = { ...before, receipt }
  const frozen = [...new Map([...old, ...quotes(after)].map((quote) => [quote.quoteHash, quote])).values()]
  expect(frozen).toHaveLength(4)
  for (const quote of frozen) expect(Result.isSuccess(verifyInferenceExpenseQuote(after, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan(frozen)).transfers).toHaveLength(3)
  const coverage = Result.getOrThrow(
    verifyInferenceExpenseCoverage(
      evidence(after),
      after.accountId,
      frozen.map((quote) => ({ quote, verifiedAt: after.asOf })),
    ),
  )
  expect(coverage.missingQuoteCount).toBe(0)
  expect(coverage.completeMeteredCoverage).toBe(true)
  const { handoffHash: _, ...material } = { ...completion.handoff, recordedAt: after.asOf }
  const corrupt = {
    ...after,
    handoff: { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) },
  }
  expect(Result.isFailure(verifyInferenceExpenseQuote(corrupt, unknown))).toBe(true)
  const replacement = Result.getOrThrow(
    makeJevResolution(request, receipt, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Recorded,
      receiptHash: receipt.receiptHash,
    }),
  )
  expect(Result.isFailure(verifyInferenceExpenseQuote({ ...after, resolution: replacement }, unknown))).toBe(true)
})

test('normal completion verifies prior unknown prefixes and books all three metered stages once', () => {
  const checkpoint = stagedCheckpointFixture(request)
  const completion = entryCompletionFixture(request)
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v3',
      requestId: request.requestId,
      startedAt: request.observedAt,
      completedAt: completion.completedAt,
      outcome: { status: JevOutcome.Completed, completion },
    }),
  )
  const resolution = Result.getOrThrow(
    makeJevResolution(request, receipt, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Recorded,
      receiptHash: receipt.receiptHash,
    }),
  )
  const before = source({
    claims: checkpoint.claims.filter((claim) => claim.stage === 'CHART'),
    terminals: [],
    skips: [],
  })
  const old = quotes(before)
  const complete = { ...source(checkpoint), receipt, resolution, handoff: completion.handoff }
  const current = quotes(complete)
  expect(current).toHaveLength(3)
  const frozen = [...old, ...current]
  for (const quote of frozen) expect(Result.isSuccess(verifyInferenceExpenseQuote(complete, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan(frozen)).transfers).toHaveLength(3)
  const coverage = Result.getOrThrow(
    verifyInferenceExpenseCoverage(
      evidence(complete),
      complete.accountId,
      frozen.map((quote) => ({ quote, verifiedAt: complete.asOf })),
    ),
  )
  expect(coverage.missingQuoteCount).toBe(0)
  expect(coverage.completeMeteredCoverage).toBe(true)
  const { handoffHash: _, ...handoffMaterial } = { ...completion.handoff, recordedAt: complete.asOf }
  const corrupt = {
    ...complete,
    handoff: { ...handoffMaterial, handoffHash: Result.getOrThrow(canonicalHashV1Result(handoffMaterial)) },
  }
  const originalQuote = old[0]
  if (originalQuote === undefined) throw new Error('Expected admitted chart quote')
  expect(Result.isFailure(verifyInferenceExpenseQuote(corrupt, originalQuote))).toBe(true)
})

test('three-stage identity preserves old keys and separates the extra provider call', () => {
  expect(inferenceStageKey({ requestId: request.requestId })).toBe(request.requestId)
  expect(inferenceStageKey({ requestId: request.requestId, stage: InferenceStage.Jev })).toBe(request.requestId)
  expect(inferenceStageKey({ requestId: request.requestId, stage: InferenceStage.Chart })).toBe(
    `${request.requestId}:CHART`,
  )
  expect(inferenceStageKey({ requestId: request.requestId, stage: InferenceStage.BaseStart })).toBe(
    `${request.requestId}:BASE_START`,
  )
})

test('an empty staged journal remains three unknown stages, not zero or a dispatched quote', () => {
  const value = source({ claims: [], terminals: [], skips: [] })
  expect(quotes(value)).toHaveLength(0)
  const report = Result.getOrThrow(makeInferenceCostReport(evidence(value), inferenceExpenseRateCard))
  expect(report.requests).toHaveLength(3)
  expect(report.unknownUsageCount).toBe(3)
  expect(report.requests.every((line) => line.estimatedCostPicoUsd === null)).toBe(true)
  expect(
    Result.isFailure(
      decodeInferenceCostEvidence({ ...rawEvidence(value), schemaVersion: 'bayn.inference-cost-evidence.v3' }),
    ),
  ).toBe(true)
})

test('snapshot cuts reject a claim or terminal committed after asOf', () => {
  const terminal = chartTerminalFor()
  const claimSource = source({ claims: [chartClaim], terminals: [], skips: [] })
  const beforeClaim = new Date(Date.parse(chartClaim.claimedAt) - 1).toISOString()
  expect(Result.isFailure(decodeInferenceCostEvidence({ ...rawEvidence(claimSource), asOf: beforeClaim }))).toBe(true)
  const { terminalHash: _, ...terminalMaterial } = terminal
  const lateTerminal = Result.getOrThrow(
    makeStagedTerminalReceipt({ ...terminalMaterial, recordedAt: claimSource.asOf }),
  )
  const terminalSource = source({ claims: [chartClaim], terminals: [lateTerminal], skips: [] })
  expect(
    Result.isFailure(decodeInferenceCostEvidence({ ...rawEvidence(terminalSource), asOf: request.observedAt })),
  ).toBe(true)
})

test('late BASE_START metering preserves both unknown quote histories without charging CHART twice', () => {
  const chartTerminal = chartTerminalFor()
  if (chartTerminal.outcome.status !== 'RECEIVED') throw new Error('Expected chart response')
  const { requestHash, responseHash, response: chartResponse } = chartTerminal.outcome.inference
  const prepared = Result.getOrThrow(
    makeSelectedBaseStartStageRequest(chartSource, { requestHash, responseHash, response: chartResponse }),
  )
  if (prepared.status !== 'PREPARED') throw new Error('Expected requested base stage')
  const baseClaim = Result.getOrThrow(
    makeStagedDispatchClaim({
      schemaVersion: 'bayn.staged-dispatch-claim.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      providerRequestHash: prepared.requestHash,
      predecessorHash: chartTerminal.terminalHash,
      selectedEnd: prepared.selectedEnd,
      claimedAt: request.observedAt,
      expiresAt: request.expiresAt,
    }),
  )
  const initialQuotes = quotes(source({ claims: [chartClaim], terminals: [], skips: [] }))
  const before = source({ claims: [chartClaim, baseClaim], terminals: [chartTerminal], skips: [] })
  const priorQuotes = quotes(before)
  expect(priorQuotes).toHaveLength(2)
  const response = responseFor(prepared.request)
  const terminal = Result.getOrThrow(
    makeStagedTerminalReceipt({
      schemaVersion: 'bayn.staged-terminal-receipt.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      claimHash: baseClaim.claimHash,
      recordedAt: before.asOf,
      outcome: {
        status: 'RECEIVED',
        inference: {
          requestHash: prepared.requestHash,
          responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
          response,
          startedAt: request.observedAt,
          completedAt: before.asOf,
        },
      },
    }),
  )
  const resolution = Result.getOrThrow(
    makeJevResolution(request, null, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Abandoned,
      abandonedAt: request.expiresAt,
    }),
  )
  const after = {
    ...before,
    resolution,
    stagedCheckpoint: { claims: [chartClaim, baseClaim], terminals: [chartTerminal, terminal], skips: [] },
  }
  const frozen = [
    ...new Map([...initialQuotes, ...priorQuotes, ...quotes(after)].map((quote) => [quote.quoteHash, quote])).values(),
  ]
  expect(frozen).toHaveLength(5)
  for (const quote of frozen) expect(Result.isSuccess(verifyInferenceExpenseQuote(after, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan(frozen)).transfers).toHaveLength(2)
  const coverage = Result.getOrThrow(
    verifyInferenceExpenseCoverage(
      evidence(after),
      after.accountId,
      frozen.map((quote) => ({ quote, verifiedAt: after.asOf })),
    ),
  )
  expect(coverage.missingQuoteCount).toBe(0)
  expect(coverage.gapRequestCount).toBe(1)
  expect(coverage.completeMeteredCoverage).toBe(false)
  const base = quotes(after).find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.BaseStart)
  if (base === undefined) throw new Error('Missing base expense')
  expect(base.schemaVersion).toBe('bayn.inference-expense-quote.v4')
  expect(base.rate?.provider).toBe('openai')
  const { quoteHash: _, ...material } = { ...base, line: { ...base.line, stageClaimHash: null } }
  expect(
    Result.isFailure(
      decodeInferenceExpenseQuote({ ...material, quoteHash: Result.getOrThrow(canonicalHashV1Result(material)) }),
    ),
  ).toBe(true)
})

test('authenticated no_base is a zero BASE_START expense while missing evidence remains unknown', () => {
  const terminal = chartTerminalFor(true)
  const skip = Result.getOrThrow(
    makeStagedSkipReceipt({
      schemaVersion: 'bayn.staged-skip-receipt.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      predecessorHash: terminal.terminalHash,
      reason: 'NO_BASE',
      recordedAt: request.observedAt,
    }),
  )
  const value = source({ claims: [chartClaim], terminals: [terminal], skips: [skip] })
  const values = quotes(value)
  expect(values).toHaveLength(2)
  const base = values.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.BaseStart)
  expect(base?.line.usageStatus).toBe(InferenceUsageStatus.NotDispatched)
  expect(base?.line.estimatedCostPicoUsd).toBe('0')
  for (const quote of values) expect(Result.isSuccess(verifyInferenceExpenseQuote(value, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan(values)).transfers).toHaveLength(1)
  const absent = source({ claims: [chartClaim], terminals: [terminal], skips: [] })
  const missing = Result.getOrThrow(makeInferenceCostReport(evidence(absent), inferenceExpenseRateCard)).requests.find(
    (line) => 'stage' in line && line.stage === InferenceStage.BaseStart,
  )
  expect(missing?.usageStatus).toBe(InferenceUsageStatus.Unknown)
})
