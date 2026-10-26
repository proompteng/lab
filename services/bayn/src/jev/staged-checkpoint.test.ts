import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { decodeStagedCheckpoint, makeStagedDispatchClaim, makeStagedTerminalReceipt } from './staged-checkpoint'
import {
  entryEvaluationRequestFixture,
  entryCompletionFixture,
  stagedCheckpointFixture,
} from './entry-inference.test-support'
import { readStagedInferenceCostEvidence } from './staged-inference-cost-evidence'
import { makeJevEvaluationReceipt, JevOutcome } from './evidence'
import { makeJevResolution, JevResolutionStatus } from './resolution'

const request = entryEvaluationRequestFixture()
const checkpoint = stagedCheckpointFixture(request)
test('staged journal binds selected end and preserves incomplete dispatch as unknown', () => {
  expect(Result.isSuccess(decodeStagedCheckpoint(request, checkpoint))).toBe(true)
  const empty = Result.getOrThrow(
    readStagedInferenceCostEvidence({
      request,
      handoff: null,
      receipt: null,
      resolution: null,
      stagedCheckpoint: { claims: [], terminals: [], skips: [] },
    }),
  )
  expect(empty.visualStages.map((row) => row.outcome)).toEqual(['UNKNOWN', 'UNKNOWN'])
  for (const change of [
    { selectedEnd: 'wrong-end' },
    { predecessorHash: 'a'.repeat(64) },
    { providerRequestHash: 'b'.repeat(64) },
  ]) {
    const base = checkpoint.claims[1]
    if (base === undefined) throw new Error('Expected base claim')
    const { claimHash: _, ...material } = base
    const changed = Result.getOrThrow(makeStagedDispatchClaim({ ...material, ...change }))
    expect(
      Result.isFailure(decodeStagedCheckpoint(request, { ...checkpoint, claims: [checkpoint.claims[0], changed] })),
    ).toBe(true)
  }
  expect(
    Result.isFailure(
      decodeStagedCheckpoint(request, { ...checkpoint, claims: [...checkpoint.claims, checkpoint.claims[0]] }),
    ),
  ).toBe(true)
})
test('full staged handoff reproduces two separate visual calls and rejects terminal substitution', () => {
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
  const row = { request, receipt, resolution, handoff: completion.handoff, stagedCheckpoint: checkpoint }
  const graph = Result.getOrThrow(readStagedInferenceCostEvidence(row))
  expect(graph.visualStages.map((stage) => stage.outcome)).toEqual(['RECEIVED', 'RECEIVED'])
  const base = checkpoint.terminals[1]
  if (base?.outcome.status !== 'RECEIVED') throw new Error('Expected base response')
  const { terminalHash: _, ...material } = base
  const response = {
    ...base.outcome.inference.response,
    usage: { ...base.outcome.inference.response.usage, input_tokens: 101, total_tokens: 101 },
  }
  const changed = Result.getOrThrow(
    makeStagedTerminalReceipt({
      ...material,
      outcome: {
        status: 'RECEIVED',
        inference: {
          ...base.outcome.inference,
          response,
          responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
        },
      },
    }),
  )
  expect(
    Result.isFailure(
      readStagedInferenceCostEvidence({
        ...row,
        stagedCheckpoint: { ...checkpoint, terminals: [checkpoint.terminals[0], changed] },
      }),
    ),
  ).toBe(true)
})
