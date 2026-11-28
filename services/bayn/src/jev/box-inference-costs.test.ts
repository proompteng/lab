import { decodeStagedCheckpoint, makeStagedDispatchClaim, makeStagedSkipReceipt } from './staged-checkpoint'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  decodeInferenceCostEvidence,
  makeInferenceCostReport,
  InferenceStage,
  InferenceUsageStatus,
} from '../inference-costs'
import {
  buildInferenceExpensePlan,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseQuote,
  type InferenceExpenseSource,
} from '../inference-expense'
import {
  entryEvaluationRequestFixture,
  entryCompletionFixture,
  stagedCheckpointFixture,
} from './entry-inference.test-support'
import { JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevResolutionStatus, makeJevResolution } from './resolution'

const request = entryEvaluationRequestFixture()
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
const checkpoint = stagedCheckpointFixture(request)
const source = (): InferenceExpenseSource => ({
  accountId: 'box-cost-test',
  sessionDate: '2026-10-25',
  asOf: request.expiresAt,
  requestId: request.requestId,
  cycleId: request.cycleId,
  authorityGenerationHash: request.authorityGenerationHash,
  request,
  receipt,
  resolution: Result.getOrThrow(
    makeJevResolution(request, receipt, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Recorded,
      receiptHash: receipt.receiptHash,
    }),
  ),
  handoff: completion.handoff,
  stagedCheckpoint: checkpoint,
})
const report = (row: InferenceExpenseSource) => {
  const { accountId, sessionDate, asOf, ...evidence } = row
  const decoded = Result.getOrThrow(
    decodeInferenceCostEvidence({
      schemaVersion: 'bayn.inference-cost-evidence.v4',
      accountBindingHash: Result.getOrThrow(
        canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
      ),
      sessionDate,
      asOf,
      requests: [evidence],
    }),
  )
  return Result.getOrThrow(makeInferenceCostReport(decoded, inferenceExpenseRateCard))
}

test('current Box completion prices exactly CHART and JEV against the 1.14 tariff', () => {
  const row = source()
  const result = report(row)
  expect(result.requests).toHaveLength(2)
  expect(result.requests.map((line) => ('stage' in line ? line.stage : null))).toEqual([
    InferenceStage.Jev,
    InferenceStage.Chart,
  ])
  expect(result.requests.every((line) => line.model === 'jev-1.14.0')).toBe(true)
  expect(result.unknownUsageCount).toBe(0)
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(row, inferenceExpenseRateCard))
  expect(quotes).toHaveLength(2)
  for (const quote of quotes) expect(Result.isSuccess(verifyInferenceExpenseQuote(row, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(2)
})

test('an empty Box journal has two unknown calls and never invents BASE_START or zero consumption', () => {
  const row = {
    ...source(),
    receipt: null,
    resolution: null,
    handoff: null,
    stagedCheckpoint: { claims: [], terminals: [], skips: [] },
  }
  const result = report(row)
  expect(result.requests).toHaveLength(2)
  expect(result.unknownUsageCount).toBe(2)
  expect(Result.getOrThrow(makeInferenceExpenseQuotes(row, inferenceExpenseRateCard))).toHaveLength(0)
})

test('a late final judgment retains its frozen unknown prefix and charges each actual call once', () => {
  const resolution = Result.getOrThrow(
    makeJevResolution(request, null, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Abandoned,
      abandonedAt: request.expiresAt,
    }),
  )
  const before = { ...source(), receipt: null, resolution }
  const earlier = Result.getOrThrow(makeInferenceExpenseQuotes(before, inferenceExpenseRateCard))
  expect(
    earlier.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Jev)?.line.usageStatus,
  ).toBe(InferenceUsageStatus.Unknown)
  const after = { ...before, receipt }
  const all = [
    ...new Map(
      [...earlier, ...Result.getOrThrow(makeInferenceExpenseQuotes(after, inferenceExpenseRateCard))].map((quote) => [
        quote.quoteHash,
        quote,
      ]),
    ).values(),
  ]
  expect(all).toHaveLength(3)
  for (const quote of all) expect(Result.isSuccess(verifyInferenceExpenseQuote(after, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan(all)).transfers).toHaveLength(2)
})

test('a v40 checkpoint refuses a validly sealed BASE_START claim or skip', () => {
  const chart = checkpoint.claims[0]
  const terminal = checkpoint.terminals[0]
  if (chart === undefined || terminal === undefined) throw new Error('Missing Box checkpoint')
  const { claimHash: _hash, ...material } = chart
  const base = Result.getOrThrow(
    makeStagedDispatchClaim({
      ...material,
      stage: 'BASE_START',
      predecessorHash: terminal.terminalHash,
      selectedEnd: 'bar_2026-10-25T06:58:00.000Z',
    }),
  )
  expect(
    Result.isFailure(decodeStagedCheckpoint(request, { ...checkpoint, claims: [...checkpoint.claims, base] })),
  ).toBe(true)
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
  expect(Result.isFailure(decodeStagedCheckpoint(request, { ...checkpoint, skips: [skip] }))).toBe(true)
})
