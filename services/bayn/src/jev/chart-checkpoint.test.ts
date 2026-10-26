import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { InferenceUsageStatus } from '../inference-costs'
import {
  buildInferenceExpensePlan,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseQuote,
  type InferenceExpenseSource,
} from '../inference-expense'
import { makeNativeChartEvidence } from './chart-evidence'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { makeChartDecisionsRequest } from './chart-questions'
import {
  decodeChartCheckpoint,
  makeChartDispatchClaim,
  makeChartTerminalReceipt,
  verifyChartCheckpointHandoff,
} from './chart-checkpoint'
import {
  chartInferenceFixture,
  entryCompletionFixture,
  entryEvaluationRequestFixture,
} from './entry-inference.test-support'

const request = entryEvaluationRequestFixture()
const prepared = Result.getOrThrow(
  makeChartDecisionsRequest(Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))),
)
const claim = Result.getOrThrow(
  makeChartDispatchClaim({
    schemaVersion: 'bayn.chart-dispatch-claim.v1',
    stage: 'CHART',
    requestId: request.requestId,
    providerRequestHash: prepared.requestHash,
    claimedAt: request.observedAt,
    expiresAt: request.expiresAt,
  }),
)
const inference = chartInferenceFixture(request.request, request.observedAt)
const terminal = Result.getOrThrow(
  makeChartTerminalReceipt({
    schemaVersion: 'bayn.chart-terminal-receipt.v1',
    requestId: request.requestId,
    claimHash: claim.claimHash,
    recordedAt: request.observedAt,
    outcome: { status: 'RECEIVED', inference },
  }),
)
const source: InferenceExpenseSource = {
  accountId: 'checkpoint-test',
  sessionDate: '2026-10-25',
  asOf: '2026-10-25T07:01:00.000Z',
  requestId: request.requestId,
  cycleId: request.cycleId,
  authorityGenerationHash: request.authorityGenerationHash,
  request,
  receipt: null,
  resolution: null,
  handoff: null,
  chartCheckpoint: { claim, terminal: null },
}
const quotes = (value: InferenceExpenseSource) =>
  Result.getOrThrow(makeInferenceExpenseQuotes(value, inferenceExpenseRateCard))
const chartQuote = (value: InferenceExpenseSource) => {
  const quote = quotes(value).find((item) => 'stage' in item.line && item.line.stage === 'CHART')
  if (quote === undefined) throw new Error('Missing chart quote')
  return quote
}

test('unresolved discovery freezes only CHART and abandonment creates the first stable Jev quote', () => {
  const initial = quotes(source)
  expect(initial).toHaveLength(1)
  const resolution = Result.getOrThrow(
    makeJevResolution(request, null, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Abandoned,
      abandonedAt: request.expiresAt,
    }),
  )
  const abandoned = { ...source, resolution }
  const after = quotes(abandoned)
  expect(after).toHaveLength(2)
  expect(chartQuote(abandoned).quoteHash).toBe(initial[0]?.quoteHash)
  for (const quote of [...initial, ...after])
    expect(Result.isSuccess(verifyInferenceExpenseQuote(abandoned, quote))).toBe(true)
  const late = { ...abandoned, chartCheckpoint: { claim, terminal } }
  for (const quote of [...initial, ...after, ...quotes(late)])
    expect(Result.isSuccess(verifyInferenceExpenseQuote(late, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan([...initial, ...after, ...quotes(late)])).transfers).toHaveLength(
    1,
  )
})

test('claim-only crash remains unknown; late terminal creates immutable metered identity without a handoff', () => {
  const unknown = chartQuote(source)
  expect(unknown.schemaVersion).toBe('bayn.inference-expense-quote.v3')
  expect(unknown.line.usageStatus).toBe(InferenceUsageStatus.Unknown)
  expect(Result.getOrThrow(buildInferenceExpensePlan([unknown])).transfers).toHaveLength(0)
  const { terminalHash: _, ...terminalMaterial } = terminal
  const late = Result.getOrThrow(
    makeChartTerminalReceipt({
      ...terminalMaterial,
      recordedAt: source.asOf,
      outcome: { status: 'RECEIVED', inference: { ...inference, completedAt: source.asOf } },
    }),
  )
  const value = { ...source, chartCheckpoint: { claim, terminal: late } }
  expect(Result.isSuccess(decodeChartCheckpoint(request, value.chartCheckpoint))).toBe(true)
  const priced = chartQuote(value)
  expect(priced.quoteHash).not.toBe(unknown.quoteHash)
  expect(priced.line.usageStatus).toBe(InferenceUsageStatus.Received)
  expect(Result.isSuccess(verifyInferenceExpenseQuote(value, unknown))).toBe(true)
  expect(Result.isSuccess(verifyInferenceExpenseQuote(value, priced))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan([unknown, priced])).transfers).toHaveLength(1)
  expect(request.expiresAt).toBe('2026-10-25T07:00:42.000Z')
})

test('committing the same handoff preserves chart quote identity and rejects substituted provider evidence', () => {
  const completion = entryCompletionFixture(request)
  const disposition = completion.handoff.disposition
  if (disposition.status === 'VISUAL_FAILED' || disposition.status === 'SOURCE_INFEASIBLE')
    throw new Error('Expected visual')
  const exact = Result.getOrThrow(
    makeChartTerminalReceipt({
      schemaVersion: 'bayn.chart-terminal-receipt.v1',
      requestId: request.requestId,
      claimHash: claim.claimHash,
      recordedAt: completion.handoff.recordedAt,
      outcome: { status: 'RECEIVED', inference: disposition.visual },
    }),
  )
  const value = { ...source, chartCheckpoint: { claim, terminal: exact } }
  const before = chartQuote(value)
  const after = chartQuote({ ...value, handoff: completion.handoff })
  expect(after.quoteHash).toBe(before.quoteHash)
  expect(Result.isSuccess(verifyChartCheckpointHandoff(value.chartCheckpoint, completion.handoff))).toBe(true)
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v2',
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
  const completed = { ...value, handoff: completion.handoff, receipt, resolution }
  expect(Result.isSuccess(verifyInferenceExpenseQuote(completed, chartQuote(source)))).toBe(true)
  expect(Result.isSuccess(verifyInferenceExpenseQuote(completed, before))).toBe(true)
  const substituted = {
    ...completion.handoff,
    disposition: { ...disposition, visual: { ...disposition.visual, responseHash: 'f'.repeat(64) } },
  }
  expect(Result.isFailure(verifyChartCheckpointHandoff(value.chartCheckpoint, substituted))).toBe(true)
})

test('rehashing a wrong request, expired claim, response or cross-request terminal never authenticates it', () => {
  for (const change of [
    { providerRequestHash: 'f'.repeat(64) },
    { claimedAt: request.expiresAt },
    { requestId: 'e'.repeat(64) },
  ]) {
    const { claimHash: _, ...material } = { ...claim, ...change }
    const changed = { ...material, claimHash: Result.getOrThrow(canonicalHashV1Result(material)) }
    expect(Result.isFailure(decodeChartCheckpoint(request, { claim: changed, terminal: null }))).toBe(true)
  }
  for (const change of [
    { requestId: 'f'.repeat(64) },
    { claimHash: 'e'.repeat(64) },
    { recordedAt: '2026-10-25T07:00:31.000Z' },
  ]) {
    const { terminalHash: _, ...material } = { ...terminal, ...change }
    const changed = { ...material, terminalHash: Result.getOrThrow(canonicalHashV1Result(material)) }
    expect(Result.isFailure(decodeChartCheckpoint(request, { claim, terminal: changed }))).toBe(true)
  }
  const { terminalHash: _, ...material } = terminal
  const changed = {
    ...material,
    outcome: { status: 'RECEIVED', inference: { ...inference, responseHash: 'f'.repeat(64) } },
  }
  expect(
    Result.isFailure(
      decodeChartCheckpoint(request, {
        claim,
        terminal: { ...changed, terminalHash: Result.getOrThrow(canonicalHashV1Result(changed)) },
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(decodeChartCheckpoint(request, { claim: { ...claim, stage: 'BASE_START' }, terminal: null })),
  ).toBe(true)
})
