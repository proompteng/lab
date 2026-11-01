import { retainedIntradayExecutionModel } from '../strategy/intraday-market'
import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { IntradayCandidateEvidencePolicy } from '../market-data/intraday/model'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalHashV1Result } from '../hash'
import { makeNativeChartEvidence } from './chart-evidence'
import { decodeJevEvaluationRequest, JevOutcome } from './evidence'
import { entryEvaluationRequestFixture, stagedCheckpointFixture } from './entry-inference.test-support'
import { makeRetainedFundedEntryJudgmentRequest } from './retained-funded-entry-questions'
import { decodeStagedCheckpoint, stageResponseIdentity } from './staged-checkpoint'
import {
  readStagedInferenceCostEvidence,
  retainedStagedQuestionPolicyHash,
  retainedMarketQuestionPolicyHash,
} from './staged-inference-cost-evidence'
import { makeRetainedMarketEntryJudgmentRequest } from './retained-market-entry-questions'
import { deriveEntryDispositionForChart } from './entry-inference'
import {
  stagedChartAssessments,
  makeInitialChartStageRequest,
  makeSelectedBaseStartStageRequest,
} from './retained-filtered-staged-chart-questions'
import * as retainedCandidateChartStages from './retained-candidate-staged-chart-questions'
import * as currentChartStages from './staged-chart-questions'
import { makeEntryJudgmentRequest } from './entry-questions'
import {
  jevProtocolSchemaForQuestionPolicy,
  RetainedJevProtocolV30Schema,
  RetainedJevProtocolV31Schema,
  RetainedJevProtocolV32Schema,
  RetainedJevProtocolV33Schema,
  RetainedJevProtocolV34Schema,
  RetainedJevProtocolV35Schema,
} from './protocol'

const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const fixture = (
  marketQuestions = false,
  schemaVersion:
    | 'bayn.jev.protocol.v26'
    | 'bayn.jev.protocol.v27'
    | 'bayn.jev.protocol.v28'
    | 'bayn.jev.protocol.v29'
    | 'bayn.jev.protocol.v30'
    | 'bayn.jev.protocol.v31'
    | 'bayn.jev.protocol.v32'
    | 'bayn.jev.protocol.v33'
    | 'bayn.jev.protocol.v34'
    | 'bayn.jev.protocol.v35' = 'bayn.jev.protocol.v26',
) => {
  const current = entryEvaluationRequestFixture()
  const baseProtocol = {
    ...current.request.protocol,
    executionModel: retainedIntradayExecutionModel,
    inputDefinition:
      schemaVersion === 'bayn.jev.protocol.v34' || schemaVersion === 'bayn.jev.protocol.v35'
        ? ('bayn.jev-entry-state.v23' as const)
        : ('bayn.jev-entry-state.v22' as const),
    entryQuestionPolicyHash:
      schemaVersion === 'bayn.jev.protocol.v35'
        ? current.request.protocol.entryQuestionPolicyHash
        : schemaVersion === 'bayn.jev.protocol.v33' || schemaVersion === 'bayn.jev.protocol.v34'
          ? '864658b2565a176ecad7e6e2460a9f9be9340bf9f304d5af41db81ce49551158'
          : schemaVersion === 'bayn.jev.protocol.v32'
            ? 'c6c8032291a3840de13db71ca02aaf8149b8d862e425cc24fdc5327b47cd3c03'
            : marketQuestions
              ? retainedMarketQuestionPolicyHash
              : retainedStagedQuestionPolicyHash,
  }
  const protocolMaterial =
    schemaVersion === 'bayn.jev.protocol.v30' ||
    schemaVersion === 'bayn.jev.protocol.v31' ||
    schemaVersion === 'bayn.jev.protocol.v32' ||
    schemaVersion === 'bayn.jev.protocol.v33' ||
    schemaVersion === 'bayn.jev.protocol.v34' ||
    schemaVersion === 'bayn.jev.protocol.v35'
      ? {
          ...baseProtocol,
          schemaVersion,
          candidateEvidencePolicy:
            schemaVersion === 'bayn.jev.protocol.v31' ||
            schemaVersion === 'bayn.jev.protocol.v32' ||
            schemaVersion === 'bayn.jev.protocol.v33' ||
            schemaVersion === 'bayn.jev.protocol.v34' ||
            schemaVersion === 'bayn.jev.protocol.v35'
              ? IntradayCandidateEvidencePolicy.MarketQuotesV2
              : IntradayCandidateEvidencePolicy.MarketQuotes,
        }
      : {
          ...baseProtocol,
          schemaVersion,
          lookbackMinutes: 30 as const,
          candidateEvidencePolicy:
            schemaVersion === 'bayn.jev.protocol.v29'
              ? IntradayCandidateEvidencePolicy.MarketQuotes
              : IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
        }
  const protocol = Schema.decodeUnknownSync(
    Schema.Union([
      jevProtocolSchemaForQuestionPolicy(baseProtocol.entryQuestionPolicyHash, 'bayn.jev.protocol.v26'),
      jevProtocolSchemaForQuestionPolicy(baseProtocol.entryQuestionPolicyHash, 'bayn.jev.protocol.v27'),
      jevProtocolSchemaForQuestionPolicy(baseProtocol.entryQuestionPolicyHash, 'bayn.jev.protocol.v28'),
      jevProtocolSchemaForQuestionPolicy(baseProtocol.entryQuestionPolicyHash, 'bayn.jev.protocol.v29'),
      RetainedJevProtocolV30Schema,
      RetainedJevProtocolV31Schema,
      RetainedJevProtocolV32Schema,
      RetainedJevProtocolV33Schema,
      RetainedJevProtocolV34Schema,
      RetainedJevProtocolV35Schema,
    ]),
  )(protocolMaterial)
  const input = {
    ...current.request,
    numericalState: { ...current.request.numericalState, schemaVersion: protocol.inputDefinition },
    schemaVersion:
      schemaVersion === 'bayn.jev.protocol.v35'
        ? ('bayn.entry-inference-input.v8' as const)
        : schemaVersion === 'bayn.jev.protocol.v34'
          ? ('bayn.entry-inference-input.v7' as const)
          : schemaVersion === 'bayn.jev.protocol.v30' ||
              schemaVersion === 'bayn.jev.protocol.v31' ||
              schemaVersion === 'bayn.jev.protocol.v32' ||
              schemaVersion === 'bayn.jev.protocol.v33'
            ? ('bayn.entry-inference-input.v6' as const)
            : ('bayn.entry-inference-input.v5' as const),
    protocol,
  }
  const { requestId: _, ...originalRequest } = current
  const requestMaterial = { ...originalRequest, request: input, requestHash: hash(input) }
  const request = { ...requestMaterial, requestId: hash(requestMaterial) }
  const stages =
    schemaVersion === 'bayn.jev.protocol.v35'
      ? currentChartStages
      : schemaVersion === 'bayn.jev.protocol.v33' || schemaVersion === 'bayn.jev.protocol.v34'
        ? retainedCandidateChartStages
        : { stagedChartAssessments, makeInitialChartStageRequest, makeSelectedBaseStartStageRequest }
  const checkpoint = stagedCheckpointFixture(request, request.observedAt, stages)
  const chart = Result.getOrThrow(makeNativeChartEvidence(input.chartSource))
  const visual = checkpoint.terminals.find((row) => row.stage === 'CHART')
  const base = checkpoint.terminals.find((row) => row.stage === 'BASE_START')
  if (visual?.outcome.status !== 'RECEIVED' || base?.outcome.status !== 'RECEIVED')
    throw new Error('Expected two original provider stages')
  const assessments = Result.getOrThrow(
    stages.stagedChartAssessments(
      { chart, protocol: input.protocol, funding: input.funding },
      stageResponseIdentity(visual.outcome.inference),
      stageResponseIdentity(base.outcome.inference),
    ),
  )
  const disposition = Result.getOrThrow(
    deriveEntryDispositionForChart(
      input,
      visual.outcome.inference,
      chart,
      assessments,
      schemaVersion === 'bayn.jev.protocol.v32' ||
        schemaVersion === 'bayn.jev.protocol.v33' ||
        schemaVersion === 'bayn.jev.protocol.v34' ||
        schemaVersion === 'bayn.jev.protocol.v35'
        ? makeEntryJudgmentRequest
        : marketQuestions
          ? makeRetainedMarketEntryJudgmentRequest
          : makeRetainedFundedEntryJudgmentRequest,
    ),
  )
  if (disposition.status !== 'READY') throw new Error('Expected a funded retained setup')
  const handoffMaterial = {
    schemaVersion: 'bayn.entry-handoff.v4' as const,
    requestId: request.requestId,
    inputHash: request.requestHash,
    visualRequestHash: visual.outcome.inference.requestHash,
    recordedAt: request.observedAt,
    disposition,
    baseStart: base.outcome,
  }
  const handoff = { ...handoffMaterial, handoffHash: hash(handoffMaterial) }
  const receiptMaterial = {
    schemaVersion: 'bayn.jev-evaluation-receipt.v3',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.expiresAt,
    outcome: {
      status: JevOutcome.Completed,
      completion: { handoff, completedAt: request.expiresAt, jev: { status: 'NOT_DISPATCHED' } },
    },
  }
  const receipt = { ...receiptMaterial, receiptHash: hash(receiptMaterial) }
  return { request, receipt, handoff, resolution: null, stagedCheckpoint: checkpoint }
}

test('original staged questions and cost receipts survive the equity policy migration without executable decoding', () => {
  expect(retainedStagedQuestionPolicyHash).toBe('05b4cc847d516888abecf982abd8ca6207f62f8f642bd2381c44a9051717a305')
  const row = fixture()
  const decoded = Result.getOrThrow(readStagedInferenceCostEvidence(row))
  expect(decoded.request.requestId).toBe(row.request.requestId)
  expect(decoded.handoff?.handoffHash).toBe(row.handoff.handoffHash)
  expect(decoded.receipt?.receiptHash).toBe(row.receipt.receiptHash)
  expect(decoded.visualStages.map((stage) => stage.outcome)).toEqual(['RECEIVED', 'RECEIVED'])
  expect(row.handoff.disposition.jevRequest.questions).toHaveProperty('support_recovery_target_obstructed')
  expect(Result.isFailure(decodeJevEvaluationRequest(row.request))).toBe(true)
  expect(Result.isFailure(decodeStagedCheckpoint(row.request, row.stagedCheckpoint))).toBe(true)
})

test('retained staged receipts cannot omit their original obstruction question after rehashing', () => {
  const row = fixture()
  const { support_recovery_target_obstructed: _, ...questions } = row.handoff.disposition.jevRequest.questions
  const jevRequest = { ...row.handoff.disposition.jevRequest, questions }
  const { handoffHash: _handoffHash, ...originalHandoff } = row.handoff
  const handoffMaterial = {
    ...originalHandoff,
    disposition: { ...row.handoff.disposition, jevRequest, jevRequestHash: hash(jevRequest) },
  }
  const handoff = { ...handoffMaterial, handoffHash: hash(handoffMaterial) }
  const { receiptHash: _receiptHash, ...originalReceipt } = row.receipt
  const receiptMaterial = {
    ...originalReceipt,
    outcome: { ...originalReceipt.outcome, completion: { ...originalReceipt.outcome.completion, handoff } },
  }
  const receipt = { ...receiptMaterial, receiptHash: hash(receiptMaterial) }
  expect(Result.isFailure(readStagedInferenceCostEvidence({ ...row, handoff, receipt }))).toBe(true)
})

test.each([
  'bayn.jev.protocol.v26',
  'bayn.jev.protocol.v27',
  'bayn.jev.protocol.v28',
  'bayn.jev.protocol.v29',
  'bayn.jev.protocol.v30',
  'bayn.jev.protocol.v31',
  'bayn.jev.protocol.v32',
  'bayn.jev.protocol.v33',
  'bayn.jev.protocol.v34',
  'bayn.jev.protocol.v35',
] as const)(
  'the ask-cap migration reads original %s market questions without admitting retired execution',
  (version) => {
    const row = fixture(true, version)
    const decoded = Result.getOrThrow(readStagedInferenceCostEvidence(row))
    expect(decoded.request.requestId).toBe(row.request.requestId)
    expect(decoded.handoff?.handoffHash).toBe(row.handoff.handoffHash)
    expect(decoded.receipt?.receiptHash).toBe(row.receipt.receiptHash)
    expect(row.handoff.disposition.jevRequest.questions).toHaveProperty('equity_support_recovery_confirmed')
    expect(Result.isFailure(decodeJevEvaluationRequest(row.request))).toBe(true)
    expect(Result.isFailure(decodeStagedCheckpoint(row.request, row.stagedCheckpoint))).toBe(true)
  },
)

test('financial reader initializes independently under the production Node module order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-financial-reader-'))
  try {
    const entry = join(directory, 'reader.ts')
    const reader = new URL('./sequential-inference-cost-evidence.ts', import.meta.url).pathname
    const effect = new URL('../../node_modules/effect/dist/index.js', import.meta.url).pathname
    await writeFile(
      entry,
      `import { readSequentialInferenceCostEvidence } from ${JSON.stringify(reader)};
import { Result } from ${JSON.stringify(effect)};
const result = readSequentialInferenceCostEvidence({ request: null, receipt: null, handoff: null, resolution: null });
if (!Result.isFailure(result)) throw new Error('Malformed financial source was accepted');
process.stdout.write('reader_ready');\n`,
    )
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: directory,
      target: 'node',
      external: ['tigerbeetle-node', '@platformatic/kafka'],
    })
    if (!build.success) throw new AggregateError(build.logs, 'Financial Node reader proof did not compile')
    const child = Bun.spawn(['node', join(directory, 'reader.js')], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Financial Node reader initialization failed: ${stderr}`)
    expect(stdout).toBe('reader_ready')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
