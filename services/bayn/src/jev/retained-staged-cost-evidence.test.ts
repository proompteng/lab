import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalHashV1Result } from '../hash'
import { makeNativeChartEvidence } from './chart-evidence'
import { decodeJevEvaluationRequest, JevOutcome } from './evidence'
import {
  entryEvaluationRequestFixture,
  entryCompletionFixture,
  stagedCheckpointFixture,
} from './entry-inference.test-support'
import { makeRetainedFundedEntryJudgmentRequest } from './retained-funded-entry-questions'
import {
  decodeStagedCheckpoint,
  makeStagedDispatchClaim,
  makeStagedTerminalReceipt,
  makeStagedSkipReceipt,
} from './staged-checkpoint'
import { readStagedInferenceCostEvidence, retainedStagedQuestionPolicyHash } from './staged-inference-cost-evidence'

const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const fixture = () => {
  const current = entryEvaluationRequestFixture()
  const completion = entryCompletionFixture(current)
  const checkpoint = stagedCheckpointFixture(current)
  const input = {
    ...current.request,
    protocol: { ...current.request.protocol, entryQuestionPolicyHash: retainedStagedQuestionPolicyHash },
  }
  const { requestId: _, ...originalRequest } = current
  const requestMaterial = { ...originalRequest, request: input, requestHash: hash(input) }
  const request = { ...requestMaterial, requestId: hash(requestMaterial) }
  const claims = checkpoint.claims.map(({ claimHash: _, ...material }) =>
    Result.getOrThrow(makeStagedDispatchClaim({ ...material, requestId: request.requestId })),
  )
  const terminalHashes = new Map<string, string>()
  const terminals = checkpoint.terminals.map(({ terminalHash, ...material }) => {
    const claim = claims.find((row) => row.stage === material.stage)
    if (claim === undefined) throw new Error('Missing original stage claim')
    const terminal = Result.getOrThrow(
      makeStagedTerminalReceipt({ ...material, requestId: request.requestId, claimHash: claim.claimHash }),
    )
    terminalHashes.set(terminalHash, terminal.terminalHash)
    return terminal
  })
  // The selected-base claim binds the chart terminal, whose request identity changed.
  const boundClaims = claims.map(({ claimHash: _, ...material }) => {
    if (material.predecessorHash === null) return Result.getOrThrow(makeStagedDispatchClaim(material))
    const predecessorHash = terminalHashes.get(material.predecessorHash)
    if (predecessorHash === undefined) throw new Error('Missing original chart predecessor')
    return Result.getOrThrow(makeStagedDispatchClaim({ ...material, predecessorHash }))
  })
  const boundTerminals = terminals.map(({ terminalHash: _, ...material }) => {
    const claim = boundClaims.find((row) => row.stage === material.stage)
    if (claim === undefined) throw new Error('Missing bound stage claim')
    return Result.getOrThrow(makeStagedTerminalReceipt({ ...material, claimHash: claim.claimHash }))
  })
  const skips = checkpoint.skips.map(({ skipHash: _, ...material }) =>
    Result.getOrThrow(
      makeStagedSkipReceipt({
        ...material,
        requestId: request.requestId,
        predecessorHash:
          material.predecessorHash === null
            ? null
            : (terminalHashes.get(material.predecessorHash) ?? material.predecessorHash),
      }),
    ),
  )
  const disposition = completion.handoff.disposition
  if (disposition.status !== 'READY') throw new Error('Expected a funded retained setup')
  const prepared = Result.getOrThrow(
    makeRetainedFundedEntryJudgmentRequest({
      numericalState: input.numericalState,
      chart: Result.getOrThrow(makeNativeChartEvidence(input.chartSource)),
      assessments: disposition.assessments,
      proposals: disposition.evaluation.proposals,
    }),
  )
  if (prepared === null) throw new Error('Missing original Jev request')
  const { handoffHash: _handoffHash, ...originalHandoff } = completion.handoff
  const handoffMaterial = {
    ...originalHandoff,
    requestId: request.requestId,
    inputHash: request.requestHash,
    disposition: { ...disposition, jevRequest: prepared.request, jevRequestHash: prepared.requestHash },
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
  return {
    request,
    receipt,
    handoff,
    resolution: null,
    stagedCheckpoint: { claims: boundClaims, terminals: boundTerminals, skips },
  }
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
