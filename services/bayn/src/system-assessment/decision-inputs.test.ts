import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { decideJevEntry } from '../jev/decision'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { requiredInferenceInputs } from './decision-inputs'
import { EntryInferenceJournal, evaluateClaimedEntryInference } from '../jev/entry-inference'
import { JevClient } from '../jev/client'
import { DecisionsClient } from '../jev/decisions'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import { makeJevBatchResult } from '../jev/batch'

describe('all used model responses retain their actual availability', () => {
  test('a reproduced source-infeasible handoff retains its evidence without inventing provider responses', async () => {
    const evidence = nativeJevDecisionEvidence(
      nativeJevFixture(undefined, undefined, undefined, undefined, undefined, undefined, undefined, false),
    )
    const planned = evidence.batchPlan.candidates.find((candidate) => candidate.symbol === 'AMZN')
    if (planned === undefined || planned.status === 'EXCLUDED') throw new Error('Missing requested candidate')
    const completion = await Effect.runPromise(
      TestClock.setTime(Date.parse(evidence.decidedAt)).pipe(
        Effect.andThen(
          evaluateClaimedEntryInference({
            requestId: planned.request.requestId,
            input: planned.request.request,
            observedAt: planned.request.observedAt,
            expiresAt: planned.request.expiresAt,
            claimedAt: evidence.decidedAt,
          }),
        ),
        Effect.provideService(EntryInferenceJournal, {
          recordVisualClaim: () => Effect.die('Infeasible source cannot claim visual dispatch'),
          recordVisualTerminal: () => Effect.die('Infeasible source cannot receive visual evidence'),
          recordHandoff: () => Effect.succeed({ dispatchAllowed: true }),
        }),
        Effect.provideService(DecisionsClient, {
          evaluate: () => Effect.die('Infeasible source cannot call chart provider'),
        }),
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Infeasible source cannot call Jev provider') }),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(completion.handoff.disposition.status).toBe('SOURCE_INFEASIBLE')
    expect(completion.jev.status).toBe('NOT_REQUESTED')
    const receipt = Result.getOrThrow(
      makeJevEvaluationReceipt(planned.request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: planned.request.requestId,
        startedAt: evidence.decidedAt,
        completedAt: completion.completedAt,
        outcome: { status: JevOutcome.Completed, completion },
      }),
    )
    const resolution = Result.getOrThrow(
      makeJevResolution(planned.request, receipt, {
        schemaVersion: 'bayn.jev-evaluation-resolution.v1',
        requestId: planned.request.requestId,
        status: JevResolutionStatus.Recorded,
        receiptHash: receipt.receiptHash,
      }),
    )
    const { resultHash: _resultHash, ...material } = evidence.batchResult
    const batchResult = Result.getOrThrow(
      makeJevBatchResult(evidence.batchPlan, {
        ...material,
        candidates: material.candidates.map((candidate) =>
          candidate.symbol === planned.symbol && candidate.status === 'RESOLVED'
            ? { ...candidate, receipt, resolution }
            : candidate,
        ),
      }),
    )
    const before = requiredInferenceInputs(Result.getOrThrow(decideJevEntry(evidence)))
    const inputs = requiredInferenceInputs(Result.getOrThrow(decideJevEntry({ ...evidence, batchResult })))
    expect(inputs).toHaveLength(before.length - 1)
    expect(inputs).toContainEqual({ contentHash: receipt.receiptHash, availableAt: receipt.completedAt })
    expect(inputs).toContainEqual({
      contentHash: completion.handoff.handoffHash,
      availableAt: completion.handoff.recordedAt,
    })
    expect(inputs.every((input) => /^[0-9a-f]{64}$/.test(input.contentHash))).toBe(true)
  })

  test.each([true, false])('retains sequential visual and Jev responses for entry support=%s', (support) => {
    const evidence = nativeJevDecisionEvidence(undefined, support)
    const target = Result.getOrThrow(decideJevEntry(evidence))
    const inputs = requiredInferenceInputs(target)
    expect(inputs).toContainEqual({
      contentHash: evidence.batchResult.resultHash,
      availableAt: evidence.batchResult.completedAt,
    })
    let responses = 0
    for (const row of evidence.batchResult.candidates) {
      if (row.status !== 'RESOLVED' || row.receipt === null) continue
      expect(inputs).toContainEqual({ contentHash: row.receipt.receiptHash, availableAt: row.receipt.completedAt })
      if (row.receipt.outcome.status !== 'COMPLETED') continue
      const { handoff, jev } = row.receipt.outcome.completion
      expect(inputs).toContainEqual({ contentHash: handoff.handoffHash, availableAt: handoff.recordedAt })
      if (handoff.disposition.status !== 'VISUAL_FAILED' && handoff.disposition.status !== 'SOURCE_INFEASIBLE') {
        responses++
        expect(inputs).toContainEqual({
          contentHash: handoff.disposition.visual.responseHash,
          availableAt: handoff.disposition.visual.completedAt,
        })
      }
      if (jev.status === 'RECEIVED') {
        responses++
        expect(inputs).toContainEqual({
          contentHash: jev.inference.responseHash,
          availableAt: jev.inference.completedAt,
        })
      }
      if (handoff.baseStart.status === 'RECEIVED') {
        responses++
        expect(inputs).toContainEqual({
          contentHash: handoff.baseStart.inference.responseHash,
          availableAt: handoff.baseStart.inference.completedAt,
        })
      }
    }
    expect(responses).toBeGreaterThan(0)
  })
})
