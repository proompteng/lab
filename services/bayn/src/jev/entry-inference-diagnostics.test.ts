import { expect, test } from 'bun:test'
import { Effect, Exit, Layer, Logger, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { operationalError } from '../errors'
import { JevClient } from './client'
import { DecisionsClient } from './decisions'
import { EntryInferenceJournal, prepareClaimedEntry } from './entry-inference'
import { evaluateClaimedEntryInferences } from './entry-inference-batch'
import { entryHandoffDiagnostic } from './entry-inference-diagnostics'
import { entryCompletionFixture, entryEvaluationRequestFixture } from './entry-inference.test-support'
import { JevEvaluationStore, makeJevDispatch } from './evaluation'
import { makeJevEvaluationRequest } from './evidence'
import { prepareEntryInferenceInput } from './entry-inference-input'

const noQuantityRequest = () => {
  const original = entryEvaluationRequestFixture()
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...original.request,
      funding: { ...original.request.funding, capitalMicros: '1' },
    }),
  )
  return Result.getOrThrow(
    makeJevEvaluationRequest({
      schemaVersion: original.schemaVersion,
      cycleId: original.cycleId,
      authorityGenerationHash: original.authorityGenerationHash,
      snapshotId: original.snapshotId,
      symbol: original.symbol,
      observedAt: original.observedAt,
      expiresAt: original.expiresAt,
      request: prepared.input,
      requestHash: prepared.requestHash,
    }),
  )
}

test('projects authentic ready and unfunded derivations without provider or financial material', () => {
  const request = entryEvaluationRequestFixture()
  const ready = entryCompletionFixture(request).handoff
  expect(ready.disposition.status).toBe('READY')
  const diagnostic = entryHandoffDiagnostic(request.cycleId, ready)
  expect(diagnostic.disposition).toBe('READY')
  expect(diagnostic.proposalCount).toBeGreaterThan(0)
  expect(Object.keys(diagnostic).sort()).toEqual([
    'cycleId',
    'disposition',
    'event',
    'handoffHash',
    'proposalCount',
    'rejectionCounts',
    'requestId',
  ])
  const unfunded = entryCompletionFixture(noQuantityRequest()).handoff
  expect(entryHandoffDiagnostic(request.cycleId, unfunded)).toMatchObject({
    disposition: 'NO_FUNDED_PROPOSALS',
    proposalCount: 0,
    rejectionCounts: [{ reason: 'NO_BUY_QUANTITY', count: 2 }],
  })
  const serialized = JSON.stringify(diagnostic)
  for (const forbidden of [
    'response',
    'usage',
    'funding',
    'capitalMicros',
    'bidMicros',
    'askMicros',
    'questions',
    'bars',
  ])
    expect(serialized).not.toContain(forbidden)
})

const runSourceInfeasible = async (mode: 'success' | 'commit-failure' | 'replay' | 'logger-defect') => {
  const request = noQuantityRequest()
  const claim = {
    requestId: request.requestId,
    observedAt: request.observedAt,
    claimedAt: request.observedAt,
    expiresAt: request.expiresAt,
    input: request.request,
  }
  const prepared = Result.getOrThrow(prepareClaimedEntry(claim))
  expect(prepared.visualClaim).toBeNull()
  const messages: unknown[] = []
  let committed = false
  const logger = Logger.make(({ message }) => {
    expect(committed).toBe(true)
    if (mode === 'logger-defect') throw new Error('diagnostic sink unavailable')
    messages.push(...(Array.isArray(message) ? message : [message]))
  })
  const layer = Layer.mergeAll(
    TestClock.layer(),
    Logger.layer([logger]),
    Layer.succeed(EntryInferenceJournal, {
      recordVisualClaims: () => Effect.die('Source-infeasible entry must not dispatch'),
      recordTransitions: (transitions) =>
        Effect.gen(function* () {
          if (mode === 'commit-failure')
            return yield* operationalError({
              component: 'database',
              operation: 'test-commit',
              message: 'commit failed',
            })
          committed = true
          return transitions.map(() => ({ requestId: request.requestId, dispatchAllowed: mode !== 'replay' }))
        }),
    }),
    Layer.succeed(DecisionsClient, { evaluate: () => Effect.die('Unexpected paid visual call') }),
    Layer.succeed(JevClient, { evaluate: () => Effect.die('Unexpected paid judgment call') }),
    Layer.succeed(JevEvaluationStore, {
      read: () => Effect.die('Unexpected read'),
      abandon: () => Effect.die('Unexpected abandon'),
      recordAll: () => Effect.die('Unexpected partial receipt'),
    }),
  )
  const exit = await Effect.runPromiseExit(
    evaluateClaimedEntryInferences([
      makeJevDispatch({
        request,
        claimedAt: claim.claimedAt,
        visualClaim: prepared.visualClaim,
      }),
    ]).pipe(Effect.provide(layer)),
  )
  return { exit, messages, request }
}

test('source-infeasible committed handoff emits one bounded correlated event without provider calls', async () => {
  const { exit, messages, request } = await runSourceInfeasible('success')
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    event: 'bayn.entry-handoff-diagnostic.v1',
    cycleId: request.cycleId,
    requestId: request.requestId,
    disposition: 'SOURCE_INFEASIBLE',
    proposalCount: 0,
    rejectionCounts: [],
  })
})

test.each(['commit-failure', 'replay'] as const)('%s emits no newly committed handoff diagnostic', async (mode) => {
  const { exit, messages } = await runSourceInfeasible(mode)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(messages).toEqual([])
})

test('diagnostic logger defect does not change a committed handoff completion', async () => {
  const { exit, messages } = await runSourceInfeasible('logger-defect')
  expect(Exit.isSuccess(exit)).toBe(true)
  if (Exit.isSuccess(exit)) expect(exit.value[0]?.handoff.disposition.status).toBe('SOURCE_INFEASIBLE')
  expect(messages).toEqual([])
})
