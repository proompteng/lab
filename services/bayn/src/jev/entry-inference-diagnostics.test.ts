import { expect, test } from 'bun:test'
import { Effect, Exit, Layer, Logger, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { operationalError } from '../errors'
import { JevClient } from './client'
import { DecisionsClient } from './decisions'
import {
  EntryInferenceJournal,
  EntrySourceFeasibilityReason,
  evaluateEntrySourceFeasibility,
  hasFeasibleEntrySource,
  prepareClaimedEntry,
} from './entry-inference'
import { makeNativeChartEvidence } from './chart-evidence'
import { evaluateClaimedEntryInferences } from './entry-inference-batch'
import { entryHandoffDiagnostic } from './entry-inference-diagnostics'
import { entryCompletionFixture, entryEvaluationRequestFixture } from './entry-inference.test-support'
import { JevEvaluationStore, makeJevDispatch } from './evaluation'
import { makeJevEvaluationRequest, type JevEvaluationRequest } from './evidence'
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

const prepare = (request: JevEvaluationRequest) =>
  Result.getOrThrow(
    prepareClaimedEntry({
      requestId: request.requestId,
      input: request.request,
      observedAt: request.observedAt,
      expiresAt: request.expiresAt,
      claimedAt: request.observedAt,
    }),
  )

const quietCryptoRequest = () => {
  const original = entryEvaluationRequestFixture()
  const symbol = 'ETH/USD'
  const bars = original.request.chartSource.bars.map((bar) => ({
    ...bar,
    open: 100,
    high: 100.03,
    low: 99.99,
    close: 100,
  }))
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...original.request,
      chartSource: { ...original.request.chartSource, symbol, bars },
      numericalState: { ...original.request.numericalState, candidate: { symbol, bars1m: bars } },
      funding: { ...original.request.funding, bidMicros: '100000000', askMicros: '100010000' },
    }),
  )
  return Result.getOrThrow(
    makeJevEvaluationRequest({
      schemaVersion: original.schemaVersion,
      cycleId: original.cycleId,
      authorityGenerationHash: original.authorityGenerationHash,
      snapshotId: original.snapshotId,
      symbol,
      observedAt: original.observedAt,
      expiresAt: original.expiresAt,
      request: prepared.input,
      requestHash: prepared.requestHash,
    }),
  )
}

test.each([
  {
    fixture: entryEvaluationRequestFixture,
    feasible: true,
    reason: EntrySourceFeasibilityReason.Feasible,
    requestHash: 'be19f5d58f4b86cd7939f762abbce434e211afc0bb8a01b4f9574a088eab8ee6',
    claimHash: 'a044472ea9dea0e0115d61cc2c08ea60be4dc4db1399adc774170f5775a53768',
  },
  {
    fixture: noQuantityRequest,
    feasible: false,
    reason: EntrySourceFeasibilityReason.NoExecutableQuantity,
    requestHash: 'ccb33549552054b35da7e18c2102059fb3c0ee7ce7e340556e308c4363cd7fd8',
    claimHash: null,
  },
  {
    fixture: quietCryptoRequest,
    feasible: false,
    reason: EntrySourceFeasibilityReason.NoFundedSourceStructure,
    requestHash: '5beadcb12b1bfc032dbde19e33532658a5f638abbe67841d04bec302cc5f15f6',
    claimHash: null,
  },
])(
  'retains pre-change boolean and immutable identity oracles for $reason',
  ({ fixture, feasible, reason, requestHash, claimHash }) => {
    const request = fixture()
    const prepared = prepare(request)
    const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
    expect(Result.getOrThrow(hasFeasibleEntrySource(request.request, chart))).toBe(feasible)
    expect(prepared.sourceFeasibility).toMatchObject({ feasible, reason })
    expect(request.requestHash).toBe(requestHash)
    expect(prepared.visualClaim?.claimHash ?? null).toBe(claimHash)
    if (!feasible)
      expect(prepared.sourceFeasibility).toMatchObject({
        supportBarCount: 0,
        resistanceBarCount: 0,
        baseWindowCount: 0,
      })
  },
)

test('feasibility diagnostic preserves invalid economics as failure rather than an abstention', () => {
  const request = entryEvaluationRequestFixture()
  const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
  const invalid = { ...request.request, funding: { ...request.request.funding, askMicros: '0' } }
  const diagnostic = evaluateEntrySourceFeasibility(invalid, chart)
  const boolean = hasFeasibleEntrySource(invalid, chart)
  expect(Result.isFailure(diagnostic)).toBe(true)
  expect(Result.isFailure(boolean)).toBe(true)
  if (Result.isFailure(diagnostic) && Result.isFailure(boolean)) {
    expect(diagnostic.failure._tag).toBe('JevContractError')
    expect(boolean.failure.message).toBe(diagnostic.failure.message)
  }
})

test('projects authentic ready and unfunded derivations without provider or financial material', () => {
  const request = entryEvaluationRequestFixture()
  const ready = entryCompletionFixture(request).handoff
  expect(ready.disposition.status).toBe('READY')
  expect(ready.handoffHash).toBe('df3b19ef518e023c26f92593d2e4d521229f6272d99bf61ce25517ecb94f46b9')
  const diagnostic = entryHandoffDiagnostic(request.cycleId, ready, prepare(request).sourceFeasibility)
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
    'sourceFeasibility',
  ])
  const unfunded = entryCompletionFixture(noQuantityRequest()).handoff
  expect(
    entryHandoffDiagnostic(request.cycleId, unfunded, prepare(noQuantityRequest()).sourceFeasibility),
  ).toMatchObject({
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

const runSourceInfeasible = async (
  mode: 'success' | 'commit-failure' | 'replay' | 'logger-defect',
  request = noQuantityRequest(),
) => {
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
    sourceFeasibility: {
      reason: 'NO_EXECUTABLE_QUANTITY',
      supportBarCount: 0,
      resistanceBarCount: 0,
      baseWindowCount: 0,
    },
  })
})

test('quiet crypto source logs no funded structure, not a quantity failure, after commit', async () => {
  const { exit, messages } = await runSourceInfeasible('success', quietCryptoRequest())
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    disposition: 'SOURCE_INFEASIBLE',
    sourceFeasibility: {
      reason: 'NO_FUNDED_SOURCE_STRUCTURE',
      supportBarCount: 0,
      resistanceBarCount: 0,
      baseWindowCount: 0,
    },
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
